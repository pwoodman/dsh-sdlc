/**
 * packages/sdlc-client-ui/src/client/locales.js — `sdlc` namespace dictionaries.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sdlc';

/** English dictionary (the key-set source of truth). */
export const en = {
  'tab.label': 'SDLC',
  'tab.title': 'DSH SDLC Flow',
  'status.loading': 'Loading flow status…',
  'status.missing': 'Status unavailable: {reason}',
  'status.empty': 'No project initialised — run `sdlc init` first.',
  'status.tasks': '{count} tasks',
  'status.spend': '${cost} (estimate) · {tokens} tokens',
  'board.loading': 'Loading task board…',
  'board.missing': 'Board unavailable: {reason}',
  'board.empty': 'No tasks yet.',
  'config.loading': 'Loading configuration…',
  'config.missing': 'Configuration unavailable: {reason}',
  'config.save': 'Save',
  'config.saving': 'Saving…',
  'config.saved': 'Saved.',
  'config.invalid': 'Rejected: {reason}',
  'config.validationErrors': '{count} error(s)',
  'review.pickRuns': 'Pick two runs of a task to compare.',
  'review.loading': 'Loading comparison…',
  'review.missing': 'Comparison unavailable: {reason}',
  'review.compare': 'Compare',
  'review.traceTitle': 'Trace path',
  'panel.status': 'Status',
  'panel.board': 'Board',
  'panel.config': 'Config',
  'panel.review': 'Review',
};

/** Simplified Chinese dictionary. */
export const zh = {
  'tab.label': 'SDLC',
  'tab.title': 'SDLC 编排器',
  'status.loading': '正在加载编排器状态…',
  'status.missing': '状态不可用：{reason}',
  'status.empty': '尚未初始化项目 — 请先运行 `sdlc init`。',
  'status.tasks': '{count} 个任务',
  'status.spend': '${cost}（估算）· {tokens} tokens',
  'board.loading': '正在加载任务看板…',
  'board.missing': '看板不可用：{reason}',
  'board.empty': '暂无任务。',
  'config.loading': '正在加载配置…',
  'config.missing': '配置不可用：{reason}',
  'config.save': '保存',
  'config.saving': '保存中…',
  'config.saved': '已保存。',
  'config.invalid': '已拒绝：{reason}',
  'config.validationErrors': '{count} 个错误',
  'review.pickRuns': '选择同一任务的两次运行进行对比。',
  'review.loading': '正在加载对比…',
  'review.missing': '对比不可用：{reason}',
  'review.compare': '对比',
  'review.traceTitle': '追踪路径',
  'panel.status': '状态',
  'panel.board': '看板',
  'panel.config': '配置',
  'panel.review': '复核',
};

export default { NS, en, zh };
