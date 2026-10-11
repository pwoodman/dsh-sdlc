/**
 * packages/sdlc-core/src/yaml-lite.js — a minimal, dependency-free YAML subset.
 *
 * WHY: `dsh` ships no YAML parser we may import, and the reference environment
 * has no network to install one. `.sdlc/config.yml`, `.sdlc/tiers/*.yml` and
 * task contracts are the only YAML this project *reads*, and they use a small,
 * fixed subset. This module implements exactly that subset and rejects
 * everything else loudly rather than guessing.
 *
 * SUPPORTED: block mappings, block sequences, flow mappings `{a: 1, b: two}`,
 * flow sequences `[a, b]`, quoted/unquoted scalars, numbers, booleans, null,
 * `#` comments, blank lines, nested indentation (spaces only).
 *
 * NOT SUPPORTED (throws): anchors/aliases, tags, multi-line scalars (`|`, `>`),
 * tabs for indentation, multiple documents. Task contracts use JSON.
 */

export class YamlError extends Error {}

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      break;
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+$/, '');
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(s) || /^-?\d+[eE][-+]?\d+$/.test(s)) return Number.parseFloat(s);
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s);
  return s;
}

function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === '[' || ch === '{') { depth += 1; cur += ch; }
    else if (ch === ']' || ch === '}') { depth -= 1; cur += ch; }
    else if (ch === sep && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function parseFlow(text) {
  const s = text.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`unterminated flow sequence: ${s}`);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map((p) => parseScalar(p));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError(`unterminated flow mapping: ${s}`);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const out = {};
    for (const entry of splitTopLevel(inner)) {
      const idx = entry.indexOf(':');
      if (idx < 0) throw new YamlError(`flow mapping entry without colon: ${entry}`);
      const key = parseScalar(entry.slice(0, idx));
      out[String(key)] = parseScalar(entry.slice(idx + 1));
    }
    return out;
  }
  return parseScalar(s);
}

function splitKey(line) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) { if (ch === quote && line[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ']' || ch === '}') { depth -= 1; continue; }
    if (ch === ':' && depth === 0 && (i + 1 >= line.length || /\s/.test(line[i + 1]))) {
      return [line.slice(0, i), line.slice(i + 1)];
    }
  }
  return null;
}

/** Parse a YAML document (subset) into plain JS values. */
export function parseYaml(text) {
  const rawLines = String(text).split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const withoutComment = stripComment(rawLines[i]);
    if (withoutComment.trim() === '') continue;
    if (withoutComment.includes('\t')) throw new YamlError(`tab indentation is not supported (line ${i + 1})`);
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, content: withoutComment.trim(), line: i + 1 });
  }
  if (lines.length === 0) return null;

  let cursor = 0;

  function parseBlock(indent) {
    const first = lines[cursor];
    if (!first) return null;
    const isSeq = first.content === '-' || first.content.startsWith('- ');
    const container = isSeq ? [] : {};
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(`unexpected indentation at line ${line.line}`);
      if (isSeq) {
        if (!(line.content === '-' || line.content.startsWith('- '))) break;
        const rest = line.content.slice(1).trim();
        cursor += 1;
        if (rest === '') {
          container.push(parseNested(indent));
        } else {
          const kv = splitKey(rest);
          if (kv && !rest.startsWith('[') && !rest.startsWith('{')) {
            // "- key: value" starts a mapping that continues at deeper indent
            const item = {};
            const [k, v] = kv;
            if (v.trim() === '') item[String(parseScalar(k))] = parseNested(indent + 2, line.indent);
            else item[String(parseScalar(k))] = parseScalar(v);
            // continuation lines of this mapping are indented > this line's indent
            while (cursor < lines.length && lines[cursor].indent > indent) {
              const cont = lines[cursor];
              if (cont.indent <= indent) break;
              const ckv = splitKey(cont.content);
              if (!ckv) throw new YamlError(`expected "key: value" at line ${cont.line}`);
              const [ck, cv] = ckv;
              cursor += 1;
              item[String(parseScalar(ck))] = cv.trim() === '' ? parseNested(cont.indent + 2, cont.indent) : parseScalar(cv);
            }
            container.push(item);
          } else {
            container.push(parseScalar(rest));
          }
        }
      } else {
        const kv = splitKey(line.content);
        if (!kv) throw new YamlError(`expected "key: value" at line ${line.line}`);
        const [k, v] = kv;
        const key = String(parseScalar(k));
        cursor += 1;
        container[key] = v.trim() === '' ? parseNested(indent + 1) : parseScalar(v);
      }
    }
    return container;
  }

  function parseNested(parentIndent, fromIndent = null) {
    if (cursor >= lines.length) return null;
    const next = lines[cursor];
    if (next.indent <= (fromIndent ?? parentIndent - 1)) return null;
    return parseBlock(next.indent);
  }

  const result = parseBlock(lines[0].indent);
  if (cursor !== lines.length) throw new YamlError(`unparsed content at line ${lines[cursor].line}`);
  return result;
}

function needsQuote(s) {
  return s === '' || /^[\s>|&*!%@`{}[\],#?:-]|[:#]\s|\s$|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s);
}

function scalarToYaml(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/** Serialize plain JS values to the same YAML subset. */
export function dumpYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const body = dumpYaml(item, indent + 2);
          return `${pad}- ${body.trimStart()}`;
        }
        if (Array.isArray(item)) {
          return `${pad}-\n${dumpYaml(item, indent + 2)}`;
        }
        return `${pad}- ${scalarToYaml(item)}`;
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        const key = needsQuote(k) ? JSON.stringify(k) : k;
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${key}: []`;
          return `${pad}${key}:\n${dumpYaml(v, indent + 2)}`;
        }
        if (v !== null && typeof v === 'object') {
          if (Object.keys(v).length === 0) return `${pad}${key}: {}`;
          return `${pad}${key}:\n${dumpYaml(v, indent + 2)}`;
        }
        return `${pad}${key}: ${scalarToYaml(v)}`;
      })
      .join('\n');
  }
  return `${pad}${scalarToYaml(value)}`;
}

export default { parseYaml, dumpYaml, YamlError };
