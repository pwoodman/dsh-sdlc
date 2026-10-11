/**
 * packages/sdlc-core/src/context.js — deterministic context assembly (spec v3 B.11).
 *
 * Every worker prompt is EXACTLY these blocks, in this order, under a token
 * budget. Truncation is priority-based: drop block 4, then 5, then 7 — never
 * 1–3 (role, constitution, contract) and never 6 (failure evidence, which is
 * the whole point of a retry). The manifest is persisted in
 * `worker_runs.context_manifest_json`, so context decisions are auditable.
 */

export const BLOCK_ORDER = [
  { n: 1, name: 'role-preamble', droppable: false },
  { n: 2, name: 'constitution-excerpt', droppable: false },
  { n: 3, name: 'task-contract', droppable: false },
  { n: 4, name: 'relevant-files', droppable: true },
  { n: 5, name: 'relevant-decisions', droppable: true },
  { n: 6, name: 'failure-evidence', droppable: false },
  { n: 7, name: 'architecture-summary', droppable: true },
];

export const DEFAULT_TRUNCATION_PRIORITY = [4, 5, 7];

export function estimateTokens(text) {
  // Deterministic, dependency-free estimate: ~4 bytes per token.
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 4);
}

/** Fixed section → domain map for the constitution excerpt (deterministic). */
export const CONSTITUTION_SECTIONS = [
  { id: 'S1', domains: ['requirements'], text: 'Requirements are captured as statements with acceptance criteria before architecture begins.' },
  { id: 'S2', domains: ['architecture'], text: 'Architecture decisions are recorded as ADRs; two conflicting ADRs trigger collaborative review.' },
  { id: 'S3', domains: ['backend', 'api'], text: 'APIs are versioned, validated at the boundary, and covered by contract tests.' },
  { id: 'S4', domains: ['database', 'data-pipeline'], text: 'Schema changes are migrations; every migration is reversible and tested.' },
  { id: 'S5', domains: ['security'], text: 'Security-sensitive paths require security review and least-privilege access.' },
  { id: 'S6', domains: ['ux-ui', 'frontend'], text: 'User-visible changes are verified visually at the viewport matrix and meet the a11y floor.' },
  { id: 'S7', domains: ['testing'], text: 'A behaviour change without a test change is rejected with NO_TEST_EVIDENCE.' },
  { id: 'S8', domains: ['devops'], text: 'Deployment changes are gated by build and, when production-impacting, human approval.' },
  { id: 'S9', domains: ['integration'], text: 'Only the integration manager writes the integration branch; merges are --no-ff and post-merge gated.' },
];

export function constitutionExcerpt(domains = []) {
  const set = new Set(domains);
  return CONSTITUTION_SECTIONS.filter((s) => s.domains.some((d) => set.has(d)))
    .map((s) => `${s.id}: ${s.text}`)
    .join('\n');
}

/** Render a task contract as the block-3 text (deterministic field order). */
export function renderTaskContract(contract = {}) {
  const lines = [];
  const { task = {}, ...rest } = contract;
  const t = contract.task ?? contract;
  lines.push(`task: ${t.id ?? '?'}`);
  if (t.title) lines.push(`title: ${t.title}`);
  if (t.objective) lines.push(`objective: ${t.objective}`);
  if (t.role) lines.push(`role: ${t.role}`);
  if (t.risk_class) lines.push(`risk_class: ${t.risk_class}`);
  if (t.capabilities) lines.push(`capabilities: ${[].concat(t.capabilities).join(', ')}`);
  if (t.allowed_paths) lines.push(`allowed_paths: ${[].concat(t.allowed_paths).join(', ')}`);
  if (t.forbidden_paths) lines.push(`forbidden_paths: ${[].concat(t.forbidden_paths).join(', ')}`);
  if (t.verification) lines.push(`verification: ${[].concat(t.verification).join(', ')}`);
  if (t.acceptance_criteria) {
    lines.push('acceptance_criteria:');
    for (const ac of t.acceptance_criteria) lines.push(`  - ${ac.id}: ${ac.statement} (${ac.check ?? 'manual'})`);
  }
  if (rest.domains) lines.push(`domains: ${[].concat(rest.domains).join(', ')}`);
  return lines.join('\n');
}

/** Trim a file snippet to `maxLines`, most-recently-changed first is the caller's job. */
export function snippet(content, { maxLines = 200 } = {}) {
  const lines = String(content ?? '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n… [truncated ${lines.length - maxLines} lines]`;
}

/**
 * Assemble the prompt.
 * @param {object} blocks `{1..7: string}` or `{rolePreamble, constitution, contract, files, decisions, failureEvidence, architectureSummary}`
 */
export function assembleContext(blocks = {}, {
  tokenBudget = 24000,
  truncationPriority = DEFAULT_TRUNCATION_PRIORITY,
  maxLinesPerFile = 200,
} = {}) {
  const resolved = BLOCK_ORDER.map((spec) => {
    const raw = blockFor(blocks, spec);
    const content = spec.n === 4 && Array.isArray(raw) ? null : raw;
    return { ...spec, raw, content };
  });

  // Block 4 may be an array of file snippets.
  const fileBlock = resolved.find((b) => b.n === 4);
  if (Array.isArray(fileBlock.raw)) {
    fileBlock.content = fileBlock.raw
      .map((f) => `--- ${f.path}\n${snippet(f.content, { maxLines: maxLinesPerFile })}`)
      .join('\n');
    fileBlock.files = fileBlock.raw.map((f) => f.path);
  }

  const manifest = { blocks: [], dropped: [], tokenBudget, totalTokens: 0 };

  const measure = () => resolved.reduce((sum, b) => sum + (b.dropped ? 0 : estimateTokens(b.content)), 0);
  for (const b of resolved) if (!b.content) b.dropped = b.droppable; // empty optional block

  let total = measure();
  for (const n of truncationPriority) {
    if (total <= tokenBudget) break;
    const block = resolved.find((b) => b.n === n);
    if (block && !block.dropped) {
      block.dropped = true;
      manifest.dropped.push({ n, name: block.name, reason: 'token-budget' });
      total = measure();
    }
  }

  const parts = [];
  for (const b of resolved) {
    const tokens = estimateTokens(b.content);
    manifest.blocks.push({
      n: b.n,
      name: b.name,
      tokens,
      bytes: Buffer.byteLength(b.content ?? '', 'utf8'),
      dropped: Boolean(b.dropped),
      ...(b.files ? { files: b.files } : {}),
    });
    if (!b.dropped && b.content) {
      parts.push(`## ${b.n}. ${b.name}\n\n${b.content}`);
    }
  }
  manifest.totalTokens = measure();
  manifest.overBudget = manifest.totalTokens > tokenBudget;

  return { text: parts.join('\n\n'), manifest };
}

function blockFor(blocks, spec) {
  const byNumber = blocks[spec.n];
  if (byNumber !== undefined) return byNumber;
  switch (spec.n) {
    case 1: return blocks.rolePreamble ?? blocks.role ?? '';
    case 2: return blocks.constitution ?? '';
    case 3: return blocks.contract ? renderTaskContract(blocks.contract) : '';
    case 4: return blocks.files ?? '';
    case 5: return blocks.decisions ?? '';
    case 6: return blocks.failureEvidence ?? '';
    case 7: return blocks.architectureSummary ?? '';
    default: return '';
  }
}

/** ADRs relevant to a task = tags ∩ domains (id + decision + consequence only). */
export function relevantDecisions(decisions = [], domains = []) {
  const set = new Set(domains);
  return decisions.filter((d) => (d.tags ?? []).some((t) => set.has(t)));
}

export function renderDecisions(decisions = []) {
  return decisions
    .map((d) => `- ${d.id}: ${d.decision}${d.consequence ? ` — ${d.consequence}` : ''}`)
    .join('\n');
}

export default { assembleContext, constitutionExcerpt, renderTaskContract, estimateTokens };
