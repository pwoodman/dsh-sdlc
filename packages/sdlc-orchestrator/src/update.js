/**
 * packages/sdlc-orchestrator/src/update.js — self-update check for the lead.
 *
 * The lead bundle is one npm package. This module asks the registry for the
 * newest version on the channel the installed build follows, and (by default)
 * asks DSH's plugin manager to install it. DSH cannot swap a loaded module
 * tree in place, so an update reports `restart-required`; the next start uses
 * the new package.
 *
 * The check is deliberately conservative:
 *   - only the current profile, only when its dependency is a registry spec;
 *   - link:/file:/git installs and source checkouts are never replaced;
 *   - at most one registry lookup per interval (default 24h), cached under
 *     DSH_HOME/.sdlc-update-<profile>.json;
 *   - any failure is logged and ignored — an update check never blocks boot.
 *
 * Environment:
 *   SDLC_AUTO_UPDATE=off|check|install   default: install
 *   SDLC_UPDATE_INTERVAL_HOURS=<n>       default: 24
 *   SDLC_UPDATE_REGISTRY=<url>           default: npm_config_registry or npmjs
 *   SDLC_UPDATE_CHANNEL=latest|beta      default: beta for a prerelease build
 */

import { existsSync, readdirSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  channelForVersion,
  isRegistrySource,
  normalizeReleaseAgeExcludes,
  shouldCheckForUpdate,
  updateDecision,
  writeFileAtomic,
} from './install-lib.mjs';

const MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
})();

export const UPDATE_PACKAGE = MANIFEST.name ?? '@patwoodman/dsh-sdlc-flow';
export const UPDATE_VERSION = MANIFEST.version ?? '0.0.0';
const DAY_MS = 24 * 60 * 60 * 1000;

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/** Where the once-per-interval marker is stored (one marker per profile). */
export function updateCachePath(env = process.env, profile = null) {
  const suffix = typeof profile === 'string' && profile !== '' ? `-${profile}` : '';
  return join(resolveDshHome(env), `.sdlc-update${suffix}.json`);
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
  } catch {
    // A read-only home must not turn an update check into a boot failure.
  }
}

/**
 * Find the profile that loaded this exact package copy.
 *
 * @returns {{name:string, dir:string, source:string, manifest:object}|null}
 */
function profileFromManifest(manifestPath, packageName) {
  let dir = dirname(manifestPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
        const bundles = manifest?.dsh?.profile?.bundles;
        const source = manifest?.dependencies?.[packageName];
        if (Array.isArray(bundles) && bundles.includes(packageName) && typeof source === 'string') {
          return { name: basename(dir), dir, source, manifest };
        }
      } catch {
        // Not a profile manifest; keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findInstalledProfile({ packageName = UPDATE_PACKAGE, env = process.env, ownManifestPath = MANIFEST_PATH } = {}) {
  const direct = profileFromManifest(ownManifestPath, packageName);
  if (direct !== null) return direct;
  const profiles = join(resolveDshHome(env), 'profiles');
  if (!existsSync(profiles)) return null;
  const own = safeRealpath(ownManifestPath);
  for (const name of readdirSync(profiles).sort()) {
    const dir = join(profiles, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const source = manifest?.dependencies?.[packageName];
    if (typeof source !== 'string') continue;
    const installedManifest = join(dir, 'node_modules', ...packageName.split('/'), 'package.json');
    if (!existsSync(installedManifest)) continue;
    const installed = safeRealpath(installedManifest);
    if (own !== null && installed !== null && installed !== own) continue;
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) continue;
    return { name, dir, source, manifest };
  }
  return null;
}

/** Add the exact-version pnpm release-age exemption an update needs. */
export function allowReleaseAge(profileDir, spec) {
  const file = join(profileDir, 'pnpm-workspace.yaml');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : 'packages:\n  - .\n';
  writeFileAtomic(file, normalizeReleaseAgeExcludes(text, [spec]));
}

/**
 * Read the registry's newest version for a dist-tag.
 *
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion({
  packageName = UPDATE_PACKAGE,
  channel = 'latest',
  registry = process.env.SDLC_UPDATE_REGISTRY || process.env.npm_config_registry || 'https://registry.npmjs.org',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this runtime');
  const url = String(registry).replace(/\/+$/, '') + '/' + packageName.replace('/', '%2F');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('registry returned HTTP ' + response.status);
  const packument = await response.json();
  const version = packument?.['dist-tags']?.[channel];
  if (typeof version !== 'string') {
    throw new Error('registry has no ' + channel + ' dist-tag (tags: ' + Object.keys(packument?.['dist-tags'] ?? {}).join(', ') + ')');
  }
  return version;
}

/** One check per cache path in this process; two boots must not race an install. */
const inFlight = new Map();

/**
 * Run one update check.
 *
 * Pure enough to test: the registry, clock, cache and plugin manager are all
 * injectable. It never throws.
 *
 * @returns {Promise<{status:string, latest?:string, version?:string, reason?:string, error?:string, restartRequired?:boolean}>}
 */
export async function checkForUpdate(options = {}) {
  const { mode = 'install', source, cachePath = updateCachePath() } = options;
  if (mode === 'off') return { status: 'disabled' };
  if (typeof source !== 'string' || source.trim() === '') return { status: 'skipped', reason: 'no-installed-source' };
  if (!isRegistrySource(source)) return { status: 'skipped', reason: 'non-registry-install' };

  const key = `${cachePath}\u0000${options.packageName ?? UPDATE_PACKAGE}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = runUpdateCheck({ ...options, cachePath }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function runUpdateCheck({
  currentVersion = UPDATE_VERSION,
  packageName = UPDATE_PACKAGE,
  channel = channelForVersion(currentVersion),
  source,
  manager,
  cachePath,
  now = Date.now(),
  intervalMs = DAY_MS,
  mode = 'install',
  fetchImpl = globalThis.fetch,
  registry,
  beforeInstall,
  verifyInstalled,
  allowMajor = false,
  logger,
}) {
  const cache = readCache(cachePath);
  // A failed install gets a short retry backoff (at most one hour), not the
  // full 24h interval and not a retry on every single boot.
  const failedAt = Number(cache.failedAt);
  const retryMs = Math.min(intervalMs, 60 * 60 * 1000);
  if (Number.isFinite(failedAt) && now - failedAt < retryMs) {
    return { status: 'skipped', reason: 'failure-backoff', latest: typeof cache.latest === 'string' ? cache.latest : undefined };
  }
  if (!shouldCheckForUpdate(cache.checkedAt, now, intervalMs)) {
    return { status: 'skipped', reason: 'interval', latest: typeof cache.latest === 'string' ? cache.latest : undefined };
  }

  let latest;
  try {
    latest = await fetchLatestVersion({ packageName, channel, registry, fetchImpl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.('sdlc-update: registry check failed: ' + message);
    return { status: 'error', reason: 'registry', error: message };
  }

  const decision = updateDecision({ currentVersion, latestVersion: latest, source, allowMajor });
  if (decision.action === 'up-to-date') {
    writeCache(cachePath, { checkedAt: now, latest, channel });
    return { status: 'up-to-date', latest };
  }
  if (decision.action !== 'update') {
    writeCache(cachePath, { checkedAt: now, latest, channel });
    return { status: 'skipped', reason: decision.reason, latest, ...(decision.version ? { version: decision.version } : {}) };
  }

  if (mode === 'check') {
    writeCache(cachePath, { checkedAt: now, latest, channel });
    return { status: 'available', latest, channel };
  }

  if (typeof manager?.installBundle !== 'function') {
    writeCache(cachePath, { checkedAt: now, latest, channel });
    return { status: 'available', latest, channel, reason: 'no-plugin-manager' };
  }
  try {
    await beforeInstall?.(latest);
    const result = await manager.installBundle(packageName + '@' + latest, { saveExact: true });
    if (result?.error) {
      const message = result.error.message ?? String(result.error);
      logger?.warn?.('sdlc-update: install of ' + latest + ' failed: ' + message);
      // Do NOT write the interval marker: a transient pnpm/network failure must
      // be retried after a short backoff, not suppressed for 24 hours and not
      // retried on every single boot.
      writeCache(cachePath, { ...cache, checkedAt: cache.checkedAt ?? null, latest, channel, failedAt: now, failedVersion: latest });
      return { status: 'error', latest, reason: 'install', error: message };
    }
    const observed = typeof verifyInstalled === 'function'
      ? await verifyInstalled(latest)
      : (typeof result?.version === 'string' ? result.version : null);
    if (observed === null || observed === undefined) {
      // The plugin manager said "changed" but nothing proves which version is
      // on disk. Report the uncertainty instead of claiming an install.
      logger?.warn?.('sdlc-update: install reported success but the installed version could not be verified');
      return { status: 'unverified', latest, reason: 'installed-version-unverified', restartRequired: result?.application === 'restart-required' };
    }
    if (observed !== latest) {
      const message = `expected ${latest}, found ${observed}`;
      logger?.warn?.('sdlc-update: install of ' + latest + ' did not take effect: ' + message);
      writeCache(cachePath, { ...cache, checkedAt: cache.checkedAt ?? null, latest, channel, failedAt: now, failedVersion: latest });
      return { status: 'error', latest, reason: 'installed-version-mismatch', error: message };
    }
    writeCache(cachePath, { checkedAt: now, latest, channel });
    return {
      status: 'installed',
      latest,
      version: observed,
      restartRequired: result?.application === 'restart-required',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.('sdlc-update: install of ' + latest + ' failed: ' + message);
    writeCache(cachePath, { ...cache, checkedAt: cache.checkedAt ?? null, latest, channel, failedAt: now, failedVersion: latest });
    return { status: 'error', latest, reason: 'install', error: message };
  }
}

export function updateMode(config = {}, env = process.env, currentVersion = UPDATE_VERSION) {
  const value = config.autoUpdate ?? env.SDLC_AUTO_UPDATE;
  if (value === false || value === 'false' || value === '0' || value === 'off') return 'off';
  if (value === 'check' || value === 'notify') return 'check';
  if (value === 'install') return 'install';
  // A prerelease build checks by default; auto-installing every beta on a
  // schedule is a supply-chain and trust surface, not a convenience. Stable
  // builds keep the install default. SDLC_AUTO_UPDATE=install opts in.
  return channelForVersion(currentVersion) === 'beta' ? 'check' : 'install';
}

/**
 * Schedule one non-blocking update check after activation.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] sdlc-orchestrator row config
 * @returns {NodeJS.Timeout|null}
 */
export function scheduleUpdateCheck(ctx, config = {}) {
  const env = process.env;
  const mode = updateMode(config, env, UPDATE_VERSION);
  if (mode === 'off' || env.SDLC_SELFTEST) return null;
  // Unit-test and non-Cordis harnesses pass a plain object. A real context
  // exposes get(); without it there is no plugin manager to update through.
  if (typeof ctx?.get !== 'function') return null;
  const delayMs = Number.isFinite(config.updateDelayMs) ? config.updateDelayMs : 5_000;
  const intervalHours = Number.isFinite(config.updateIntervalHours)
    ? config.updateIntervalHours
    : Number(env.SDLC_UPDATE_INTERVAL_HOURS) || 24;
  const timer = setTimeout(() => {
    runScheduledUpdate(ctx, { ...config, mode, intervalHours }).catch((error) => {
      ctx?.logger?.warn?.('sdlc-update: ' + (error instanceof Error ? error.message : String(error)));
    });
  }, Math.max(0, delayMs));
  timer.unref?.();
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => clearTimeout(timer));
  }
  return timer;
}

async function runScheduledUpdate(ctx, { mode, intervalHours, ...config }) {
  const manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : ctx?.pluginManager;
  const installed = findInstalledProfile({ env: process.env });
  if (!installed) {
    ctx?.logger?.debug?.('sdlc-update: no registry-installed profile found; skipping auto-update');
    return;
  }
  const currentVersion = UPDATE_VERSION;
  const result = await checkForUpdate({
    currentVersion,
    source: installed.source,
    manager,
    channel: config.updateChannel || process.env.SDLC_UPDATE_CHANNEL || channelForVersion(currentVersion),
    intervalMs: intervalHours * 60 * 60 * 1000,
    registry: config.updateRegistry,
    cachePath: updateCachePath(process.env, installed.name),
    mode,
    logger: ctx?.logger,
    allowMajor: config.allowMajor ?? process.env.SDLC_ALLOW_MAJOR_UPDATE === '1',
    // Trust the file on disk, not the manager's return value. A manager that
    // reports "changed" without replacing the package is not an install.
    verifyInstalled: (version) => {
      try {
        const manifestPath = join(installed.dir, 'node_modules', ...UPDATE_PACKAGE.split('/'), 'package.json');
        if (!existsSync(manifestPath)) return null;
        const actual = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
        return typeof actual === 'string' ? actual : null;
      } catch {
        return null;
      }
    },
    beforeInstall: async (latest) => {
      try {
        allowReleaseAge(installed.dir, UPDATE_PACKAGE + '@' + latest);
      } catch (error) {
        ctx?.logger?.debug?.('sdlc-update: could not write release-age exemption: ' + (error instanceof Error ? error.message : String(error)));
      }
    },
  });
  if (result.status === 'installed') {
    ctx?.logger?.warn?.('sdlc-update: installed ' + UPDATE_PACKAGE + '@' + (result.version ?? result.latest) + '; restart DeepSeek Harness to load it');
  } else if (result.status === 'available') {
    const hint = 'npx -y ' + UPDATE_PACKAGE + '@latest dsh-sdlc-install';
    ctx?.logger?.warn?.('sdlc-update: ' + result.latest + ' is available (run: ' + hint + ')');
  } else if (result.status === 'unverified') {
    ctx?.logger?.warn?.('sdlc-update: ' + result.latest + ' was requested but could not be verified on disk; restart and re-run dsh-sdlc-install --check');
  } else if (result.status === 'error') {
    ctx?.logger?.debug?.('sdlc-update: ' + (result.error ?? result.reason ?? 'check failed'));
  } else {
    ctx?.logger?.debug?.('sdlc-update: ' + result.status + (result.latest ? ' (latest ' + result.latest + ')' : ''));
  }
  return result;
}

export default { checkForUpdate, scheduleUpdateCheck, findInstalledProfile, fetchLatestVersion, updateCachePath };
