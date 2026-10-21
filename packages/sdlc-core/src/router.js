/**
 * packages/sdlc-core/src/router.js — model router v2 (spec v3 B.8).
 *
 * Deterministic rule ladder, first match wins, evaluated per ATTEMPT. Capability
 * requirements are a hard constraint and outrank the attempt ladder (rule 1);
 * everything else is a soft preference.
 *
 * Cost is ALWAYS an estimate: DSH exposes token counts but no currency metadata
 * (P20/P28), so `cost_usd = tokens × deployment-authored price table`.
 */

export const TIERS = ['cheap', 'base', 'elevated'];
export const TIER_ALIASES = { CHEAP: 'cheap', BASE: 'base', ELEVATED: 'elevated' };

export const REWORK_COST_MULTIPLIER = 1.0; // deployment-tunable; see expectedCost

export function modelKey(entry) {
  return `${entry.provider}/${entry.model}`;
}

export class ModelRouter {
  /**
   * @param {object} opts
   * @param {{cheap:Array,base:Array,elevated:Array}} opts.tiers
   * @param {Record<string,string[]>} [opts.capabilities]  by `provider/model` or bare `model`
   * @param {Record<string,{input:number,output:number}>} [opts.pricing] per 1M tokens
   * @param {Record<string,{successes:number,failures:number}>} [opts.history] by `modelId:taskType`
   * @param {Array<{provider:string,model:string,latency?:object,limits?:object}>} [opts.registry]
   * @param {object} [opts.config]
   */
  constructor({ tiers = {}, capabilities = {}, pricing = {}, history = {}, registry = [], config = {} } = {}) {
    this.tiers = tiers;
    this.capabilities = capabilities;
    this.pricing = pricing;
    this.history = history;
    this.registry = registry;
    this.config = config;
    this.decisions = [];
  }

  entriesFor(tier) {
    return this.tiers[tier] ?? [];
  }

  capabilitiesFor(entry) {
    return this.capabilities[modelKey(entry)] ?? this.capabilities[entry.model] ?? [];
  }

  /** Hard eligibility: must satisfy every required capability. */
  eligible(entry, requires = []) {
    if (requires.length === 0) return true;
    const caps = new Set(this.capabilitiesFor(entry));
    return requires.every((r) => caps.has(r) || caps.has('*'));
  }

  /** Laplace-smoothed for n<5, raw rate for n≥5 (B.8 / G.2.3 rule 7). */
  histSuccess(modelId, taskType) {
    const rec = this.history[`${modelId}:${taskType}`] ?? this.history[modelId];
    if (!rec) return 0.5;
    const s = rec.successes ?? 0;
    const f = rec.failures ?? 0;
    const n = s + f;
    if (n === 0) return 0.5;
    if (n < 5) return (s + 1) / (n + 2);
    return s / n;
  }

  sampleSize(modelId, taskType) {
    const rec = this.history[`${modelId}:${taskType}`] ?? this.history[modelId];
    if (!rec) return 0;
    return (rec.successes ?? 0) + (rec.failures ?? 0);
  }

  estimateCost(modelId, { tokens_in = 0, tokens_out = 0 } = {}) {
    const price = this.pricing[modelId];
    if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) return null;
    return (tokens_in * price.input + tokens_out * price.output) / 1_000_000;
  }

  /** expected_cost = model_cost + P(fail)·rework_cost (B.8). */
  expectedCost(entry, task = {}) {
    const modelId = modelKey(entry);
    const expectedTokens = task.expectedTokens ?? { in: 50_000, out: 10_000 };
    const modelCost = this.estimateCost(modelId, { tokens_in: expectedTokens.in, tokens_out: expectedTokens.out }) ?? 0;
    const pFail = 1 - this.histSuccess(modelId, task.task_type ?? 'default');
    const reworkCost = task.reworkCostUsd ?? (modelCost * REWORK_COST_MULTIPLIER) ?? 0;
    return modelCost + pFail * reworkCost;
  }

  _latency(entry) {
    const reg = this.registry.find((r) => modelKey(r) === modelKey(entry));
    const speed = reg?.latency?.tokensPerSecond ?? reg?.estimated_speed?.tokens_per_second;
    if (!speed) return null;
    const out = this.config.expectedOutputTokens ?? 2000;
    return out / speed;
  }

  /** Rank the eligible candidates of a tier by the documented composite score. */
  rankWithinTier(tier, task = {}) {
    const candidates = this.entriesFor(tier).filter((e) => this.eligible(e, task.requires ?? []));
    if (candidates.length <= 1) return candidates;

    const scored = candidates.map((entry) => {
      const modelId = modelKey(entry);
      const hist = this.histSuccess(modelId, task.task_type ?? 'default');
      const cost = this.expectedCost(entry, task);
      const latency = this._latency(entry) ?? 1;
      return { entry, modelId, hist, cost, latency };
    });

    const norm = (values) => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max === min) return values.map(() => 0); // constant term contributes 0
      return values.map((v) => (v - min) / (max - min));
    };
    const histN = norm(scored.map((s) => s.hist));
    // 1/cost and 1/latency: larger is better, so normalize the inverses ascending.
    const costN = norm(scored.map((s) => 1 / (s.cost || 1e-9)));
    const latencyN = norm(scored.map((s) => 1 / (s.latency || 1e-9)));

    return scored
      .map((s, i) => ({ ...s, score: 0.5 * histN[i] + 0.3 * costN[i] + 0.2 * latencyN[i] }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.cost !== b.cost) return a.cost - b.cost;                        // tie-break: lower cost
        if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId); // then stable model id
        return 0;
      })
      .map((s) => s.entry);
  }

  /** Pick one entry inside a tier; a single candidate is chosen with no scoring. */
  chooseWithinTier(tier, task = {}) {
    return this.rankWithinTier(tier, task)[0] ?? null;
  }

  /** The attempt ladder only (rules 2–8), without the capability constraint. */
  ladderTier(taskInput = {}) {
    const task = taskInput.task ?? taskInput;
    const attempt = task.attempt ?? 0;
    const gate = task.gate ?? task.verificationGate ?? null;
    const securityReview = gate === 'security' || gate === 'security-review' || gate === 'elevated-review';

    if (task.sec && securityReview) return { tier: 'elevated', rule: 2 };
    if (task.requires_elevated) return { tier: 'elevated', rule: 3 };
    if (attempt >= 2) return { tier: 'elevated', rule: 4 };
    if (attempt === 1) return { tier: 'base', rule: 5 };

    const klass = task.task_class ?? 'normal';
    if (klass === 'trivial') return { tier: 'cheap', rule: 6 };
    if (klass === 'architectural') {
      return { tier: (task.complexity ?? 0) >= 0.65 ? 'elevated' : 'base', rule: 8 };
    }
    // Rule 7: any CHEAP candidate with a strong, sufficiently-sampled history
    // for this task type wins; otherwise BASE.
    for (const entry of this.entriesFor('cheap')) {
      if (!this.eligible(entry, task.requires ?? [])) continue;
      const modelId = modelKey(entry);
      const hist = this.histSuccess(modelId, task.task_type ?? 'default');
      const n = this.sampleSize(modelId, task.task_type ?? 'default');
      if (hist >= 0.9 && n >= 5) return { tier: 'cheap', rule: 7 };
    }
    return { tier: 'base', rule: 7 };
  }

  cheapestEligibleTier(requires = []) {
    for (const tier of TIERS) {
      if (this.entriesFor(tier).some((e) => this.eligible(e, requires))) return tier;
    }
    return null;
  }

  /**
   * @returns {{tier:string|null, provider?:string, model?:string, rule:number, reason:string}}
   *   `tier:null` ⇒ NO_ELIGIBLE_MODEL (L.5: task → ESCALATED → BLOCKED).
   */
  route(taskInput = {}) {
    // Accept both `route({...taskFields})` and the documented `route({ task })`
    // call shape used by G.2.3.
    const task = taskInput.task ?? taskInput;
    const requires = task.requires ?? [];
    const ladder = this.ladderTier(task);

    // Rule 1 — capability is a HARD constraint and, per B.8's "first match
    // wins" ordering plus K.3 ("capability constraints dominate the attempt
    // ladder"), it outranks rules 2–8 completely: a task with required
    // capabilities is routed to the CHEAPEST tier that can satisfy them. This is
    // exactly the behaviour asserted by the documented G.2.3 rule-1 test.
    let tier = ladder.tier;
    let rule = ladder.rule;
    let reason = `rule ${ladder.rule}`;

    if (requires.length > 0) {
      const cheapEligible = this.cheapestEligibleTier(requires);
      if (!cheapEligible) {
        this.decisions.push({ tier: null, rule: 1, reason: 'NO_ELIGIBLE_MODEL', task: task.id ?? null });
        return { tier: null, provider: null, model: null, rule: 1, reason: 'NO_ELIGIBLE_MODEL' };
      }
      if (cheapEligible !== tier) {
        reason = `rule 1 — capability ${requires.join('+')} unsatisfiable in ${tier}; cheapest eligible tier ${cheapEligible}`;
      }
      tier = cheapEligible;
      rule = 1;
    }

    const entry = this.chooseWithinTier(tier, task);
    if (!entry) {
      const fallback = this.cheapestEligibleTier(requires);
      if (fallback) {
        const fb = this.chooseWithinTier(fallback, task);
        const decision = { tier: fallback, provider: fb.provider, model: fb.model, rule, reason: `${reason}; ${tier} empty` };
        this.decisions.push(decision);
        return decision;
      }
      this.decisions.push({ tier: null, rule, reason: 'NO_ELIGIBLE_MODEL', task: task.id ?? null });
      return { tier: null, provider: null, model: null, rule, reason: 'NO_ELIGIBLE_MODEL' };
    }

    const decision = { tier, provider: entry.provider, model: entry.model, rule, reason };
    this.decisions.push(decision);
    return decision;
  }

  /**
   * Fallback chain in the order a provider error should advance through it
   * (K.5): the routed candidate first, then every other eligible candidate in
   * SCORE ORDER (best first), tier by tier.
   */
  fallbackChain(taskInput = {}) {
    const task = taskInput.task ?? taskInput;
    const requires = task.requires ?? [];
    const chained = [];
    const seen = new Set();
    const push = (tier, entry) => {
      const id = modelKey(entry);
      if (seen.has(id)) return;
      seen.add(id);
      chained.push({ tier, provider: entry.provider, model: entry.model });
    };
    const primary = task.__primary;
    if (primary) push(primary.tier, { provider: primary.provider, model: primary.model });
    for (const tier of TIERS) {
      for (const entry of this.rankWithinTier(tier, { ...task, requires })) push(tier, entry);
    }
    return chained;
  }

  /** Fold a completed run into routing history. */
  recordOutcome(modelId, taskType, outcome, { escalated = false, tokens = 0, costUsd = 0, durationMs = 0, taskId = null, complexity = null, attempts = 1 } = {}) {
    const key = `${modelId}:${taskType}`;
    const rec = this.history[key] ?? { successes: 0, failures: 0 };
    if (outcome === 'success') rec.successes += 1;
    else rec.failures += 1;
    this.history[key] = rec;
    return { model_id: modelId, task_id: taskId, task_type: taskType, complexity, duration_ms: durationMs, tokens, cost_usd: costUsd, attempts, outcome, escalated: escalated ? 1 : 0 };
  }
}

export default { ModelRouter, TIERS };
