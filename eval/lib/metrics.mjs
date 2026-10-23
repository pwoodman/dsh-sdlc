/**
 * eval/lib/metrics.mjs — objective, dependency-free metric collectors.
 *
 * Design rule (borrowed from the plugin's own gate ethos): a metric that cannot
 * be measured returns `{available:false, note:<why>}`. It never returns a
 * plausible-looking number it cannot defend, because a fabricated metric is
 * worse than a missing one — it silently corrupts the evaluation.
 *
 * Every collector also reports `method`, so a reader can judge how strong the
 * evidence is (e.g. a regex a11y proxy is NOT axe-core).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, extname, dirname, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', '.sdlc', '.dsh', '.eval-probe']);

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift']);
const UI_EXT = new Set(['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.css']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

const TEST_RE = [/(^|\/)tests?\//i, /(^|\/)__tests__\//i, /(^|\/)spec\//i, /\.(test|spec)\.[a-z0-9]+$/i, /(^|\/)test_[^/]+\.py$/i, /_test\.go$/i];

export function isTestFile(rel) {
  return TEST_RE.some((re) => re.test(rel));
}

/** Every file under `dir`, relative and POSIX-normalised, skipping vendor dirs. */
export function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(join(dir, e.name), base));
    } else if (e.isFile()) {
      out.push(relative(base, join(dir, e.name)).split(sep).join('/'));
    }
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Strip comments/blank lines and collapse whitespace so clones are cosmetic-insensitive. */
export function normalizeLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ── collectors ──────────────────────────────────────────────────────────────

function loc(ctx) {
  let total = 0;
  const byExt = {};
  for (const f of ctx.sourceFiles) {
    // Drop ONE trailing newline so a file ending in "\n" is not counted an extra line.
    const text = (ctx.read(f) ?? '').replace(/\n$/, '');
    const n = text === '' ? 0 : text.split('\n').length;
    total += n;
    const e = extname(f) || '(none)';
    byExt[e] = (byExt[e] ?? 0) + n;
  }
  return { available: true, value: total, unit: 'lines', method: 'line-count', byExt };
}

function duplication(ctx) {
  // Minimum clone size. 4 normalized lines is the smallest block that is
  // meaningfully "a copy" rather than incidental boilerplate; at 6 the suite's
  // small duplicated validator bodies fell below the window and went unseen.
  const WINDOW = 4;
  const firstSeen = new Map();
  const flagged = new Set();
  const clones = new Set();
  let totalLines = 0;
  for (const f of ctx.sourceFiles) {
    const norm = normalizeLines(ctx.read(f) ?? '');
    totalLines += norm.length;
    for (let i = 0; i + WINDOW <= norm.length; i += 1) {
      const key = fnv1a(norm.slice(i, i + WINDOW).join('\u0000'));
      if (firstSeen.has(key)) {
        clones.add(key);
        for (let k = i; k < i + WINDOW; k += 1) flagged.add(`${f}:${k}`);
      } else {
        firstSeen.set(key, `${f}:${i}`);
      }
    }
  }
  const ratio = totalLines === 0 ? 0 : Number((flagged.size / totalLines).toFixed(4));
  return {
    available: totalLines > 0,
    value: ratio,
    unit: 'ratio',
    method: `normalized-${WINDOW}-line-window-clone-ratio`,
    clones: clones.size,
    note: `${flagged.size}/${totalLines} lines participate in a duplicated ${WINDOW}-line window (cosmetic-insensitive; proxy for jscpd)`,
  };
}

function complexity(ctx) {
  const DECISION = /\b(if|for|while|case|catch)\b|&&|\|\||\?(?!\.)/g;
  let max = 0;
  let sum = 0;
  let files = 0;
  for (const f of ctx.sourceFiles) {
    if (!JS_EXT.has(extname(f))) continue;
    const text = ctx.read(f) ?? '';
    const hits = (text.match(DECISION) ?? []).length;
    const c = 1 + hits;
    max = Math.max(max, c);
    sum += c;
    files += 1;
  }
  return {
    available: files > 0,
    value: max,
    unit: 'decision-points (max file)',
    method: 'regex-decision-point-proxy',
    mean: files ? Number((sum / files).toFixed(2)) : null,
    note: 'proxy: counts decision points per FILE, not per function (lizard/ts-complexity required for a real claim)',
  };
}

function moduleCycles(ctx) {
  const nodes = ctx.sourceFiles.filter((f) => JS_EXT.has(extname(f)));
  const index = new Map(nodes.map((f) => [f, f]));
  const graph = new Map();
  for (const f of nodes) {
    const deps = [];
    const text = ctx.read(f) ?? '';
    for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      const base = join(dirname(f), spec).split(sep).join('/').replace(/^\.\//, '');
      for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`, `${base}/index.ts`]) {
        if (index.has(cand)) { deps.push(cand); break; }
      }
    }
    graph.set(f, deps);
  }
  const color = new Map();
  const cycles = new Set();
  const stack = [];
  const visit = (n) => {
    color.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) ?? []) {
      if (color.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d)).sort().join('>');
        cycles.add(cyc);
      } else if (!color.get(d)) {
        visit(d);
      }
    }
    stack.pop();
    color.set(n, 2);
  };
  for (const n of nodes) if (!color.get(n)) visit(n);
  return {
    available: nodes.length > 0,
    value: cycles.size,
    unit: 'cycles',
    method: 'relative-import-graph-dfs',
    note: cycles.size ? [...cycles].slice(0, 5).join(' | ') : 'no relative-import cycles',
  };
}

function syntax(ctx) {
  const targets = ctx.files.filter((f) => ['.js', '.mjs', '.cjs', '.ts'].includes(extname(f)));
  const failures = [];
  for (const f of targets) {
    const abs = join(ctx.dir, f);
    let res = ctx.spawn(process.execPath, ['--check', abs]);
    const text = ctx.read(f) ?? '';
    const looksEsm = /^\s*(import|export)\b/m.test(text);
    if (res.status !== 0 && looksEsm && !extname(f).endsWith('mjs')) {
      // A .js file with ESM syntax but no `type: module` nearby: re-check as ESM
      // via stdin so this is a syntax test, not a module-system test.
      res = ctx.spawn(process.execPath, ['--input-type=module', '--check'], { input: text });
    }
    if (res.status !== 0) failures.push({ file: f, error: String(res.stderr ?? '').split('\n').slice(0, 2).join(' ') });
  }
  return {
    available: targets.length > 0,
    value: failures.length,
    unit: 'files failing node --check',
    method: 'node --check (ESM-aware)',
    failures: failures.slice(0, 10),
  };
}

function testRatio(ctx) {
  const src = ctx.sourceFiles.length;
  return {
    available: src > 0,
    value: src ? Number((ctx.testFiles.length / src).toFixed(4)) : 0,
    unit: 'test files / source files',
    method: 'path-based classification',
    tests: ctx.testFiles.length,
    sources: src,
  };
}

const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'assigned-secret', re: /\b(?:secret|token|password|passwd|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/i },
];

function secrets(ctx) {
  const hits = [];
  for (const f of ctx.files) {
    const text = ctx.read(f);
    if (text == null || text.length > 2_000_000) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        const line = text.split('\n').findIndex((l) => p.re.test(l)) + 1;
        hits.push({ file: f, line, pattern: p.id });
      }
    }
  }
  return {
    available: true,
    value: hits.length,
    unit: 'matches',
    method: 'regex-secret-scan',
    note: 'best-effort high-signal patterns; gitleaks/trufflehog required for a real claim',
    hits: hits.slice(0, 10),
  };
}

const DANGER_PATTERNS = [
  { id: 'eval', re: /\beval\s*\(/ },
  { id: 'new-function', re: /new\s+Function\s*\(/ },
  { id: 'child-process-interpolation', re: /(?:exec|execSync)\s*\(\s*[`'"][^`'"]*\$\{/ },
  { id: 'innerhtml', re: /\.innerHTML\s*=/ },
  { id: 'dangerously-set-inner-html', re: /dangerouslySetInnerHTML/ },
  { id: 'sql-string-concat', re: /(?:SELECT|INSERT|UPDATE|DELETE)[^;'"`]*['"]\s*\+/i },
  { id: 'weak-hash', re: /createHash\(\s*['"](?:md5|sha1)['"]\s*\)/i },
  { id: 'plaintext-http', re: /http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/ },
];

function dangerousPatterns(ctx) {
  const hits = [];
  for (const f of ctx.files) {
    const text = ctx.read(f);
    if (text == null || text.length > 2_000_000) continue;
    for (const p of DANGER_PATTERNS) {
      if (p.re.test(text)) {
        const line = text.split('\n').findIndex((l) => p.re.test(l)) + 1;
        hits.push({ file: f, line, pattern: p.id });
      }
    }
  }
  return {
    available: true,
    value: hits.length,
    unit: 'matches',
    method: 'regex-dangerous-pattern-scan',
    note: 'heuristic; Semgrep required for a real claim',
    hits: hits.slice(0, 10),
  };
}

function apiSurface(ctx) {
  let exports = 0;
  let routes = 0;
  for (const f of ctx.sourceFiles) {
    if (!JS_EXT.has(extname(f))) continue;
    const text = ctx.read(f) ?? '';
    exports += (text.match(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|default)\b/gm) ?? []).length;
    routes += (text.match(/\.(?:get|post|put|patch|delete)\s*\(\s*['"`]/g) ?? []).length;
    routes += (text.match(/['"`](?:GET|POST|PUT|PATCH|DELETE)\s+\//g) ?? []).length;
  }
  return {
    available: true,
    value: exports,
    unit: 'exported symbols',
    method: 'regex-export-and-route-count',
    routes,
  };
}

const A11Y_PATTERNS = [
  { id: 'img-without-alt', re: /<img\b(?![^>]*\balt=)[^>]*>/gi },
  { id: 'div-click-handler', re: /<div\b[^>]*\bonClick=/gi },
  { id: 'positive-tabindex', re: /tabIndex=\{?["']?[1-9]/gi },
  { id: 'outline-none', re: /outline:\s*(?:none|0)\b/gi },
  { id: 'autofocus-without-reason', re: /<input\b[^>]*\bautoFocus\b/gi },
];

function staticA11y(ctx) {
  const ui = ctx.files.filter((f) => UI_EXT.has(extname(f)));
  if (ui.length === 0) {
    return { available: false, value: null, unit: 'violations', method: 'static-regex-a11y-proxy', note: 'no HTML/JSX/CSS files in the repository — nothing to inspect' };
  }
  const byId = {};
  for (const f of ui) {
    const text = ctx.read(f) ?? '';
    for (const p of A11Y_PATTERNS) {
      const n = (text.match(p.re) ?? []).length;
      if (n) byId[p.id] = (byId[p.id] ?? 0) + n;
    }
  }
  const total = Object.values(byId).reduce((a, b) => a + b, 0);
  return {
    available: true,
    value: total,
    unit: 'static violations',
    method: 'static-regex-a11y-proxy',
    note: 'STATIC proxy only — axe-core + Lighthouse are required before any real a11y claim',
    byId,
  };
}

function deps(ctx) {
  const pkg = ctx.read('package.json');
  if (!pkg) return { available: false, value: null, unit: 'dependencies', method: 'package.json', note: 'no package.json' };
  try {
    const doc = JSON.parse(pkg);
    const runtime = Object.keys(doc.dependencies ?? {});
    const dev = Object.keys(doc.devDependencies ?? {});
    return { available: true, value: runtime.length, unit: 'runtime dependencies', method: 'package.json', dev: dev.length, total: runtime.length + dev.length };
  } catch {
    return { available: false, value: null, unit: 'dependencies', method: 'package.json', note: 'package.json is not valid JSON' };
  }
}

function bundleSize(ctx) {
  let bytes = 0;
  let files = 0;
  for (const f of ctx.files) {
    if (!/^(dist|build|out)\//.test(f)) continue;
    try {
      bytes += statSync(join(ctx.dir, f)).size;
      files += 1;
    } catch { /* ignore */ }
  }
  if (files === 0) return { available: false, value: null, unit: 'bytes', method: 'dist-directory-sum', note: 'no dist/build/out directory produced' };
  return { available: true, value: bytes, unit: 'bytes', method: 'dist-directory-sum', files };
}

/** Metrics that require an external artifact produced by a real tool run. */
function fromArtifact(ctx, metricId, key, unit, method, note) {
  const a = ctx.artifacts?.[key];
  if (a == null || typeof a.value !== 'number') {
    return { available: false, value: null, unit, method, note: note ?? `no ${key} artifact (produced by the live toolchain)` };
  }
  return { available: true, value: a.value, unit, method, note: a.note ?? null };
}

/**
 * Line coverage from a `node --test --experimental-test-coverage` JSON summary
 * (`collectArtifacts --coverage` writes this), or from a c8/istanbul summary.
 * Accepts the shapes: `{summary:{lines:{pct}}}`, `{total:{lines:{pct}}}`,
 * `{lines: {pct}}`, `{linePct}`, `{pct}`, or a bare number.
 */
function coverageFromArtifact(ctx) {
  const a = ctx.artifacts?.coverage;
  if (a == null) {
    return { available: false, value: null, unit: 'percent lines', method: 'node --test --experimental-test-coverage summary artifact', note: 'no coverage artifact (run eval/collect-artifacts.mjs --coverage, or supply {"coverage":{"value":<pct>}})' };
  }
  const pct = a && typeof a === 'object'
    ? a.value ?? a.pct ?? a.linePct ?? a.lines?.pct ?? a.summary?.lines?.pct ?? a.total?.lines?.pct ?? null
    : (typeof a === 'number' ? a : null);
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return { available: false, value: null, unit: 'percent lines', method: 'node --test --experimental-test-coverage summary artifact', note: 'coverage artifact has no numeric pct (expected summary.lines.pct)' };
  }
  return { available: true, value: pct, unit: 'percent lines', method: 'node --test --experimental-test-coverage summary artifact', note: a.note ?? null };
}

/**
 * Dependency vulnerabilities from an `npm audit --json` summary
 * (`collectArtifacts --audit` writes this): `{vulnerabilities: {info, low,
 * moderate, high, critical}}` counts the total, `metadata.vulnerabilities`
 * likewise, or a bare number. An `ENOLOCK`-style error document (no
 * lockfile, no network) is honestly unavailable — never zero.
 */
function auditFromArtifact(ctx) {
  const a = ctx.artifacts?.audit;
  if (a == null) {
    return { available: false, value: null, unit: 'vulnerabilities', method: 'npm audit --json artifact', note: 'no audit artifact (run eval/collect-artifacts.mjs --audit, or supply {"audit":{"value":<count>}})' };
  }
  const v = a && typeof a === 'object' ? a.value ?? a : a;
  const count = typeof v === 'number' ? v
    : (v && typeof v.vulnerabilities === 'object'
      ? ['info', 'low', 'moderate', 'high', 'critical'].reduce((n, k) => n + (Number(v.vulnerabilities[k]) || 0), 0)
      : (typeof v.metadata?.vulnerabilities?.total === 'number' ? v.metadata.vulnerabilities.total
        : (v.metadata?.vulnerabilities && typeof v.metadata.vulnerabilities === 'object'
          ? ['info', 'low', 'moderate', 'high', 'critical'].reduce((n, k) => n + (Number(v.metadata.vulnerabilities[k]) || 0), 0)
          : null)));
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return { available: false, value: null, unit: 'vulnerabilities', method: 'npm audit --json artifact', note: 'audit artifact is not a count (expected npm audit --json metadata.vulnerabilities)' };
  }
  return { available: true, value: count, unit: 'vulnerabilities', method: 'npm audit --json artifact', note: a.note ?? null };
}

const COLLECTORS = {
  loc,
  duplication,
  complexity,
  'module-cycles': moduleCycles,
  syntax,
  'test-ratio': testRatio,
  secrets,
  'dangerous-patterns': dangerousPatterns,
  'api-surface': apiSurface,
  'static-a11y': staticA11y,
  deps,
  'bundle-size': bundleSize,
  coverage: coverageFromArtifact,
  mutation: (ctx) => fromArtifact(ctx, 'mutation', 'mutation', 'mutation score', 'stryker artifact'),
  'latency-p95': (ctx) => fromArtifact(ctx, 'latency-p95', 'load', 'ms', 'k6/autocannon artifact'),
  'error-rate': (ctx) => fromArtifact(ctx, 'error-rate', 'load', 'ratio', 'k6/autocannon artifact'),
  'dependency-audit': auditFromArtifact,
};

export const COLLECTOR_IDS = Object.keys(COLLECTORS);

/**
 * Collect the requested metrics for a repository directory.
 * @param {string} dir
 * @param {{metrics?:string[], artifacts?:object, spawn?:Function, now?:()=>string}} [opts]
 */
export function collectMetrics(dir, { metrics = [], artifacts = {}, spawn = defaultSpawn, now = () => new Date().toISOString() } = {}) {
  const files = walk(dir);
  const read = (rel) => readOrNull(join(dir, rel));
  const sourceFiles = files.filter((f) => SOURCE_EXT.has(extname(f)) && !isTestFile(f));
  const testFiles = files.filter((f) => SOURCE_EXT.has(extname(f)) && isTestFile(f));
  const ctx = { dir, files, sourceFiles, testFiles, read, spawn, artifacts };

  const out = {};
  const unknown = [];
  for (const id of metrics) {
    const fn = COLLECTORS[id];
    if (!fn) {
      unknown.push(id);
      out[id] = { available: false, value: null, method: 'none', note: `unknown metric id ${id}` };
      continue;
    }
    try {
      out[id] = fn(ctx);
    } catch (err) {
      out[id] = { available: false, value: null, method: 'error', note: `collector threw: ${err?.message ?? err}` };
    }
  }
  return {
    dir,
    collectedAt: now(),
    metrics: out,
    unknownMetrics: unknown,
    fileCount: files.length,
    sourceFiles: sourceFiles.length,
    testFiles: testFiles.length,
  };
}

function defaultSpawn(cmd, args, { input } = {}) {
  const res = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export default { collectMetrics, walk, normalizeLines, isTestFile, COLLECTOR_IDS };
