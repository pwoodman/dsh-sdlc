#!/usr/bin/env node
/**
 * scripts/build-ui.mjs — zero-dependency client bundler for sdlc-client-ui.
 *
 * WHY NOT tsdown: the spec's TypeScript toolchain (C.8.2, deviation D0) is
 * unavailable offline — this environment has no pnpm workspace install and no
 * network. The browser bundle therefore ships as hand-written dependency-free
 * ESM (React is an external, resolved by the client loader at runtime), and
 * this script performs the `src/ → lib/` artifact step the DSH loader and
 * the validation harnesses consume:
 *
 *   packages/sdlc-client-ui/lib/index.js    host entry (re-export of server/plugin.js)
 *   packages/sdlc-client-ui/lib/client.js   browser entry in the
 *                                           window.__ModuleLoader__.load({ id, factory })
 *                                           closure-factory form, with `react`
 *                                           and `react/jsx-runtime` externals.
 *
 * JSX is compiled by a tiny built-in transform (createElement calls) — the
 * panels use only function components, hooks, and intrinsic elements, so no
 * general JSX compiler is needed. If a TS toolchain becomes available,
 * replacing this file with a tsdown clientBundle() call is a one-file change.
 *
 *   node scripts/build-ui.mjs [--check]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'sdlc-client-ui');
const SRC = join(PKG, 'src');
const LIB = join(PKG, 'lib');
const CHECK = process.argv.includes('--check');
// The browser factory id MUST equal the package name (DSH's client loader keys
// the module table by it), so read it from the manifest instead of repeating the
// string here — that also makes a publish-scope rename (scripts/set-scope.mjs) a
// one-time edit rather than a hunt for a hardcoded literal.
const BUNDLE_ID = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).name;

/**
 * Minimal JSX compiler for the panels' subset: intrinsic + component tags,
 * props (string literals, {expr}, spread), text children, {expr} children,
 * self-closing tags. Comment nodes ({/* *\/}) are dropped. Anything outside
 * the subset throws with the line number — the bundle must never silently
 * miscompile a component.
 */
function compileJsx(source) {
  // Strip full-line // comments (keep URLs: only lines starting with //).
  const lines = source.split('\n').filter((l) => !/^\s*\/\//.test(l));
  const text = lines.join('\n');
  let out = '';
  let i = 0;
  const lineOf = (pos) => text.slice(0, pos).split('\n').length;

  function skipWs() {
    while (/\s/.test(text[i])) i += 1;
  }

  function parseExpr(depth = 0) {
    // Parse a {...} expression for PROP values (spread, {value}): balanced
    // braces, strings respected. NOTE: never called for expression CHILDREN
    // (those use parseExprElement, which compiles nested tags).
    let expr = '';
    let d = depth;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        expr += c;
        i += 1;
        while (i < text.length && text[i] !== q) {
          if (text[i] === '\\') { expr += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
          expr += text[i];
          i += 1;
        }
        expr += text[i] ?? '';
        i += 1;
        continue;
      }
      if (c === '{') d += 1;
      if (c === '}') {
        if (d === 0) break;
        d -= 1;
      }
      expr += c;
      i += 1;
    }
    return expr;
  }

  function parseTag() {
    // Assumes text[i] === '<'. Returns { name, props, selfClosing }.
    i += 1;
    let name = '';
    while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) { name += text[i]; i += 1; }
    if (!name) throw new Error(`compileJsx: expected tag name (line ${lineOf(i)})`);
    const props = [];
    for (;;) {
      skipWs();
      if (text[i] === '/' && text[i + 1] === '>') { i += 2; return { name, props, selfClosing: true }; }
      if (text[i] === '>') { i += 1; return { name, props, selfClosing: false }; }
      if (i >= text.length) throw new Error(`compileJsx: unterminated tag <${name} (line ${lineOf(i)})`);
      if (text[i] === '{' && text[i + 1] === '.' && text[i + 2] === '.' && text[i + 3] === '.') {
        i += 4;
        const expr = parseExpr();
        if (text[i] !== '}') throw new Error(`compileJsx: bad spread (line ${lineOf(i)})`);
        i += 1;
        props.push({ spread: expr });
        continue;
      }
      let key = '';
      while (i < text.length && /[A-Za-z0-9_$-]/.test(text[i])) { key += text[i]; i += 1; }
      if (!key) throw new Error(`compileJsx: expected prop name in <${name} (line ${lineOf(i)})`);
      skipWs();
      if (text[i] !== '=') { props.push({ key, value: 'true' }); continue; }
      i += 1;
      skipWs();
      if (text[i] === '"') {
        i += 1;
        let v = '';
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') { v += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
          if (text[i] === '\n') throw new Error(`compileJsx: newline in string prop (line ${lineOf(i)})`);
          v += text[i];
          i += 1;
        }
        i += 1;
        props.push({ key, value: JSON.stringify(v) });
      } else if (text[i] === '{') {
        i += 1;
        const expr = parseExpr();
        if (text[i] !== '}') throw new Error(`compileJsx: unterminated {prop} (line ${lineOf(i)})`);
        i += 1;
        props.push({ key, value: `(${expr})` });
      } else {
        throw new Error(`compileJsx: prop value must be "string" or {expr} (line ${lineOf(i)})`);
      }
    }
  }

  function propsCode(props) {
    if (!props.length) return 'null';
    const parts = [];
    let spread = null;
    for (const p of props) {
      if (p.spread) { spread = p.spread; continue; }
      parts.push(`${JSON.stringify(p.key)}: ${p.value}`);
    }
    const obj = `{${parts.join(', ')}}`;
    return spread ? `Object.assign({}, (${spread}), ${obj})` : obj;
  }

  function parseElement() {
    const tag = parseTag();
    const isComponent = /^[A-Z_]/.test(tag.name);
    const ref = isComponent ? tag.name : JSON.stringify(tag.name);
    if (tag.selfClosing) return `__jsx(${ref}, ${propsCode(tag.props)})`;
    const children = [];
    for (;;) {
      if (i >= text.length) throw new Error(`compileJsx: <${tag.name}> never closed (line ${lineOf(i)})`);
      if (text[i] === '<' && text[i + 1] === '/') {
        i += 2;
        let close = '';
        while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) { close += text[i]; i += 1; }
        skipWs();
        if (text[i] !== '>') throw new Error(`compileJsx: bad close tag (line ${lineOf(i)})`);
        i += 1;
        if (close !== tag.name) throw new Error(`compileJsx: <${tag.name}> closed by </${close}> (line ${lineOf(i)})`);
        break;
      }
      // `/>` inside children (self-closing child like `<td />`): parseTag
      // handles it — but only when dispatched as an element. The check
      // below routes `<` + name-char to parseElement; `/` alone falls to
      // text, which would loop forever on `/>`. Guard: a `/` that starts
      // `/>` outside a tag is a syntax error in our subset — fail loud.
      if (text[i] === '<' && /[A-Za-z!]/.test(text[i + 1] ?? '')) {
        children.push(parseElement());
        continue;
      }
      if (text[i] === '<') {
        throw new Error(`compileJsx: unexpected '<' in <${tag.name}> children (line ${lineOf(i)}) — comparisons live inside {…}, not as raw children`);
      }
      if (text[i] === '{') {
        i += 1;
        if (text[i] === '*' || (text[i] === '/' && text[i + 1] === '*')) {
          // {/* comment */} — drop it.
          const end = text.indexOf('*/}', i);
          if (end === -1) throw new Error(`compileJsx: unterminated comment (line ${lineOf(i)})`);
          i = end + 3;
          continue;
        }
        // Expression child: parse balanced braces (strings/templates
        // respected), then RECURSE so nested elements compile. A bare `<`
        // comparison inside (e.g. `() => a < b` in a .map callback) is
        // expression text, not a tag — handled by the quote-aware scanner
        // inside parseExprElement().
        const expr = parseExprElement();
        if (text[i] !== '}') throw new Error(`compileJsx: unterminated {child} (line ${lineOf(i)})`);
        i += 1;
        children.push(expr);
        continue;
      }
      // Text child up to the next < or {.
      let t = '';
      while (i < text.length && text[i] !== '<' && text[i] !== '{') { t += text[i]; i += 1; }
      const norm = t.replace(/\s+/g, ' ');
      if (norm.trim()) children.push(JSON.stringify(norm));
    }
    if (!children.length) return `__jsx(${ref}, ${propsCode(tag.props)})`;
    if (children.length === 1) return `__jsx(${ref}, ${propsCode(tag.props)}, ${children[0]})`;
    return `__jsxs(${ref}, ${propsCode(tag.props)}, ${children.join(', ')})`;
  }

  /**
   * Parse an expression child with nested elements compiled: scan balanced
   * braces (quote-aware); when a `<Tag` element-start is found at depth 0 of
   * the expression, compile it recursively. A `<` that is NOT followed by a
   * tag shape (`=` after, space-then-lowercase like `a < b`, etc.) is plain
   * expression text (comparisons, generics, arrows).
   */
  function parseExprElement() {
    let out = '';
    let d = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const start = i;
        copyString();
        out += text.slice(start, i);
        continue;
      }
      if (c === '`') {
        const start = i;
        try {
          copyTemplate();
        } catch (err) {
          throw new Error(`${err.message} (template starts line ${lineOf(start)})`);
        }
        out += text.slice(start, i);
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? text.length : end;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) throw new Error(`compileJsx: unterminated comment (line ${lineOf(i)})`);
        out += text.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      // Regex literal? Heuristic: a `/` that opens an expression-position
      // regex (after `(` `,` `=` `:` `[` `!` `&` `|` `?` `{` `;` or at the
      // start of the expression) with a matching close `/flags`. Template
      // code here has none, but the scanner must not mistake a division or
      // comment for one — and must not walk INTO a regex's braces.
      if (c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
        const prev = out.trimEnd().slice(-1);
        if (prev === '' || '([{=,:;!&|?'.includes(prev)) {
          const start = i;
          const closed = copyRegex();
          if (closed) {
            out += text.slice(start, i);
            continue;
          }
        }
      }
      // Only `{`/`}` affect the depth that gates element detection.
      // `(`/`[` are transparent: `.map((g) => (<GateRow/>))` opens TWO
      // parens before the element — counting them would hide it (d=2) and
      // the expression would run to its `}` unbalanced. Strings, templates,
      // comments and regexes are consumed above, so parens here are only
      // grouping/call/paren wrappers — safe to ignore for tag detection.
      // (A `<` comparison inside parens, e.g. `(a < b)`, still fails the
      // tag-shape regex below because `b` is not followed by space//>.)
      if (c === '{') d += 1;
      if (c === '}') {
        if (d === 0) break;
        d -= 1;
      }
      // NOTE: parens/brackets do NOT gate element detection — only brace
      // depth does. `.map((g) => (<GateRow/>))`: the `(` before the arrow
      // must not hide the element. A `(` at d===0 is transparent.
      if (c === '<' && /[A-Za-z]/.test(text[i + 1] ?? '') && d === 0) {
        const rest = text.slice(i + 1);
        const m = /^[A-Za-z][A-Za-z0-9_.]*(\s|\/|>)/.exec(rest);
        if (m) {
          // Self-closing component WITHOUT props (`<Picker … />` always has
          // props here, but `<td />` does not): still a tag.
          // `<li key=` (tag) vs `a < b` (comparison): the regex above
          // already requires whitespace/slash/> after the name. `a < b`
          // would need `b` followed by `>` — `b}` / `b)` / `b,` fail here.
          out += parseElement();
          continue;
        }
      }
      out += c;
      i += 1;
    }
    return `(${out})`;
  }

  // Top-level scan: only '<' followed by a tag-name char starts an element
  // (comparisons like `a < b` and arrows `=>` are left alone). Strings,
  // template literals and comments are copied through verbatim — JSDoc like
  // `?id=<id>` must never start an element (that hung the build: the scanner
  // consumed the rest of the bundle hunting a `</id>` that never comes).
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      out += copyString();
      continue;
    }
    if (c === '`') {
      out += copyTemplate();
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      out += text.slice(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`compileJsx: unterminated block comment (line ${lineOf(i)})`);
      out += text.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === '<' && /[A-Za-z/!]/.test(text[i + 1] ?? '')) {
      // Skip HTML-looking comments and closing-tag strays outside elements.
      if (text[i + 1] === '!' || text[i + 1] === '/') { out += c; i += 1; continue; }
      out += parseElement();
      continue;
    }
    out += c;
    i += 1;
  }
  return out;

  function copyString() {
    const q = text[i];
    let s = q;
    i += 1;
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') { s += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
      if (text[i] === '\n') throw new Error(`compileJsx: newline in string (line ${lineOf(i)})`);
      s += text[i];
      i += 1;
    }
    if (i >= text.length) throw new Error(`compileJsx: unterminated string (line ${lineOf(i)})`);
    s += text[i];
    i += 1;
    return s;
  }

  function copyTemplate() {
    let s = '`';
    i += 1;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') { s += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
      if (text[i] === '$' && text[i + 1] === '{') {
        s += '${';
        i += 2;
        let d = 1;
        while (i < text.length && d > 0) {
          const ch = text[i];
          if (ch === '"' || ch === "'" || ch === '`') { s += copyStringOrTemplate(ch); continue; }
          if (ch === '{') d += 1;
          if (ch === '}') d -= 1;
          s += ch;
          i += 1;
        }
        continue;
      }
      s += text[i];
      i += 1;
    }
    if (i >= text.length) throw new Error(`compileJsx: unterminated template (line ${lineOf(i)})`);
    s += '`';
    i += 1;
    return s;
  }

  function copyStringOrTemplate(q) {
    if (q === '`') return copyTemplate();
    let s = q;
    i += 1;
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') { s += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
      s += text[i];
      i += 1;
    }
    s += text[i] ?? '';
    i += 1;
    return s;
  }

  /**
   * Try to consume a regex literal at the cursor. Returns true when a
   * `/…/flags` was consumed (cursor moved past it), false when the `/`
   * is not a regex (division, comment already handled). Character classes
   * (`[…]`) may contain unescaped `/` and braces — both are skipped.
   */
  function copyRegex() {
    let j = i + 1;
    let inClass = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n') return false;
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) break;
      j += 1;
    }
    if (j >= text.length) return false;
    // Flags must follow; a `/` closed by end-of-input or whitespace+punct
    // like `)` is division, not a regex. Heuristic: require [a-z]* then a
    // non-identifier char — and the char after flags must not be `(` (call).
    let k = j + 1;
    while (k < text.length && /[a-z]/.test(text[k])) k += 1;
    const after = text[k] ?? '';
    if (after === '(' || after === '=' || after === '.') return false;
    // Sanity: the literal must contain something regex-ish OR be at a real
    // expression position. The caller already checked position; accept.
    i = k;
    return true;
  }
}
function readClientSources() {
  const files = ['routes.js', 'client/api.js', 'client/store.js', 'client/locales.js', 'client/definition.js', 'client/panels.jsx', 'client/SdlcTab.jsx', 'client/index.js'];
  const parts = [];
  for (const rel of files) {
    const path = join(SRC, rel);
    if (!existsSync(path)) throw new Error(`client source missing: ${rel}`);
    parts.push(`//#region src/${rel}\n${stripModules(readFileSync(path, 'utf8'), rel)}\n//#endregion`);
  }
  const cssPath = join(SRC, 'client', 'SdlcTab.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  return { parts, css };
}

/**
 * Strip ESM import/export syntax for the closure-factory bundle. The client
 * sources are authored as ESM (so node --check and unit tests consume them
 * directly); the bundle concatenates them into one factory scope where
 * cross-file names resolve lexically and `react` resolves via require().
 */
function stripModules(source, rel = '') {
  let text = source;
  // Default imports cannot be wired in the concatenated factory scope: the
  // import line is stripped but its binding would never be declared, leaving a
  // ReferenceError at client-apply time (`api is not defined` — shipped broken
  // until the entry contract test called apply). Fail the build instead. Only
  // named imports resolve lexically after the `export const` bindings land.
  if (/^\s*import\s+[A-Za-z_$][\w$]*\s+from\s/m.test(text)) {
    throw new Error(`stripModules(${rel}): default imports are not wireable in the closure bundle — use named imports`);
  }
  // Remove import lines: relative imports resolve lexically in the bundle;
  // `react` resolves via the factory require() below. Imports may span
  // multiple lines (api.js: `import {\n … \n} from …`).
  const importFrom = /^\s*import\s+[^;]+?from\s+['"][^'"]+['"];?\s*$/gms;
  text = text.replace(importFrom, '/* bundled import (see concatenated sources) */');
  text = text.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '/* bundled side-effect import */');
  // `export [async] function/const X` → `X` declaration; `export default` →
  // dropped (entries are wired explicitly at the factory tail); `export {…}`
  // (single- or multi-line) → dropped.
  text = text.replace(/^export\s+default\s[^;]+;?/gm, '/* default-export (wired at factory tail) */');
  text = text.replace(/^export\s+(async\s+)?(?=function|const|let|var|class)/gm, '$1');
  const exportList = /^export\s*\{[^}]*\}.*$/gms;
  text = text.replace(exportList, '/* re-export (wired at factory tail) */');
  void rel;
  return text;
}

function buildClientBundle() {
  const { parts, css } = readClientSources();
  // The factory receives the loader's require(): react resolves through the
  // injected module table (no globals, no import map) — the ui-approval pattern.
  // NOTE: parts still contain JSX (the panels). JSX is compiled below by
  // compileJsx() — the bundle must be parseable by the browser as plain JS.
  const compiled = parts.map((p) => {
    try {
      return compileJsx(p);
    } catch (err) {
      // Report the failing part AND the source line: compileJsx reports the
      // line within the concatenated part (//#region header = line 1), so
      // map it back by printing surrounding part lines.
      const m = /line (\d+)/.exec(err.message);
      const head = p.slice(0, 60).replace(/\n/g, '\\n');
      let ctx = '';
      if (m) {
        const ln = Number(m[1]);
        const plines = p.split('\n');
        ctx = plines.slice(Math.max(0, ln - 4), ln + 2).map((l, k) => `    ${ln - 3 + k}: ${l.slice(0, 100)}`).join('\n');
      }
      throw new Error(`${err.message} [in part starting: ${head}]\n${ctx}`);
    }
  });
  const body = `
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var react_jsx_runtime = require("react/jsx-runtime");
    var useState = react.useState;
    var useSyncExternalStore = react.useSyncExternalStore;
    var __jsx = react_jsx_runtime.jsx;
    var __jsxs = react_jsx_runtime.jsxs;
    ${JSON.stringify(css.length)}; // css length marker (injected below)
    ${compiled.join('\n')}
    exports.apply = (typeof apply !== "undefined") ? apply : undefined;
    exports.inject = (typeof inject !== "undefined") ? inject : undefined;
    // The web loader runs the factory result through Cordis unwrapExports
    // (exports.default ?? exports). Without .default the namespace object is
    // the plugin and inject survives; WITH a missing default on a shape the
    // host treats as a module, inject is dropped and the tab waits forever
    // for slots/locale/sidebarRight. Always publish the plugin object as the
    // default so both branches of unwrapExports keep inject.
    exports.default = { apply: exports.apply, inject: exports.inject };
    return module.exports;
  `;
  // Inject the CSS as a style tag at factory execution (the tsdown preset pattern, simplified).
  const styleInject = `
    if (typeof document !== "undefined") {
      var cssText = ${JSON.stringify(css)};
      var tagId = ${JSON.stringify(`${BUNDLE_ID}/SdlcTab.css`)};
      if (cssText && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
        var tag = document.createElement("style");
        tag.dataset.plugin = ${JSON.stringify(BUNDLE_ID)};
        tag.dataset.pluginCss = tagId;
        tag.textContent = cssText;
        document.head.appendChild(tag);
      }
    }
  `;
  const factory = body.replace(`${JSON.stringify(css.length)}; // css length marker (injected below)`, styleInject);
  return `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(BUNDLE_ID)},\n\tfactory: (require) => {${factory}\n\t}\n});\n`;
}

function buildHostEntry() {
  return `/**
 * GENERATED by scripts/build-ui.mjs — do not edit. Host entry re-export.
 */
export { apply, registerRoutes, inject } from "./server/plugin.js";
export * as routes from "./routes.js";
export * as handlers from "./server/handlers.js";
export const PACKAGE = ${JSON.stringify(BUNDLE_ID)};
`;
}

const clientBundle = buildClientBundle();
const hostEntry = buildHostEntry();

if (CHECK) {
  let failed = 0;
  const want = new Map([['lib/index.js', hostEntry], ['lib/client.js', clientBundle]]);
  for (const [rel, content] of want) {
    const path = join(PKG, rel);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      failed += 1;
      process.stdout.write(`  sdlc-client-ui ${rel} STALE\n`);
    } else {
      process.stdout.write(`  sdlc-client-ui ${rel} up to date\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}

mkdirSync(join(LIB, 'server'), { recursive: true });
mkdirSync(join(LIB, 'client'), { recursive: true });
// Mirror the sources (the zero-dependency src/ → lib/ step, like build.mjs)
// then overwrite the two entry artifacts.
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

// Cross-package imports: src/ uses relative paths (tests see one module), lib/
// must use bare specifiers (published packages resolve via node_modules).
const DIR_TO_PKG = {};
for (const d of readdirSync(join(ROOT, 'packages'))) {
  const pj = join(ROOT, 'packages', d, 'package.json');
  if (!existsSync(pj)) continue;
  const m = JSON.parse(readFileSync(pj, 'utf8'));
  if (m.name) DIR_TO_PKG[d] = m.name;
}
function rewriteImports(text) {
  return text.replace(
    /from '((?:\.\.\/)+)sdlc-([a-z-]+)\/src\/([^']+?)\.(js|mjs)'/g,
    (_m, _d, dir, file, _e) => {
      const pkg = DIR_TO_PKG[`sdlc-${dir}`];
      if (!pkg) return _m;
      const stem = file.split('/').pop();
      const MAIN_STEMS = { '@patwoodman/dsh-sdlc-flow-cli': 'cli' };
      return (stem === 'index' || stem === MAIN_STEMS[pkg]) ? `from '${pkg}'` : `from '${pkg}/${file}'`;
    },
  );
}
function copyRewrite(from, to) {
  mkdirSync(join(to, '..'), { recursive: true });
  writeFileSync(to, rewriteImports(readFileSync(from, 'utf8')));
}
rmSync(join(LIB, 'server'), { recursive: true, force: true });
rmSync(join(LIB, 'client'), { recursive: true, force: true });
mkdirSync(join(LIB, 'server'), { recursive: true });
mkdirSync(join(LIB, 'client'), { recursive: true });
for (const rel of walk(join(SRC, 'server'))) copyRewrite(join(SRC, 'server', rel), join(LIB, 'server', rel));
for (const rel of walk(join(SRC, 'client'))) copyRewrite(join(SRC, 'client', rel), join(LIB, 'client', rel));
copyRewrite(join(SRC, 'routes.js'), join(LIB, 'routes.js'));
writeFileSync(join(LIB, 'index.js'), hostEntry);
writeFileSync(join(LIB, 'client.js'), clientBundle);
process.stdout.write(`  @patwoodman/dsh-sdlc-flow-ui built client bundle (${clientBundle.length} bytes) → lib/\n`);
