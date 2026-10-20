/**
 * packages/sdlc-client-ui/src/client/config-fields.js — the editable config
 * surface, kept out of the JSX module so it is importable by tests.
 */

/** Editable config sections: dotted path, group and control kind. */
export const CONFIG_FIELDS = [
  { path: 'execution.maxParallelWorkers', group: 'execution', label: 'Max parallel workers', labelKey: 'config.maxParallelWorkers', kind: 'string', hint: 'number or "auto"', hintKey: 'config.hintNumberOrAuto' },
  { path: 'execution.basePort', group: 'execution', label: 'Base port', labelKey: 'config.basePort', kind: 'number' },
  { path: 'execution.worktreeRetentionDays', group: 'execution', label: 'Worktree retention (days)', labelKey: 'config.worktreeRetentionDays', kind: 'number' },
  { path: 'budgets.perProject.maxCostUsd', group: 'budgets', label: 'Project cost ceiling (USD)', labelKey: 'config.maxCostUsd', kind: 'number' },
  { path: 'verification.gateTimeoutMs', group: 'verification', label: 'Gate timeout (ms)', labelKey: 'config.gateTimeoutMs', kind: 'number' },
  { path: 'escalation.loopThreshold', group: 'escalation', label: 'Loop threshold', labelKey: 'config.loopThreshold', kind: 'number' },
  { path: 'observability.logLevel', group: 'observability', label: 'Log level', labelKey: 'config.logLevel', kind: 'select', options: ['debug', 'info', 'warn', 'error'] },
  { path: 'observability.metricsExport', group: 'observability', label: 'Export Prometheus metrics', labelKey: 'config.metricsExport', kind: 'boolean' },
];

/** Display order of the settings groups. */
export const CONFIG_GROUPS = ['execution', 'budgets', 'verification', 'escalation', 'observability'];

export default { CONFIG_FIELDS, CONFIG_GROUPS };
