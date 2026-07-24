import type { CatalogModel } from '@/types/core';

const PER_MTOK = 1_000_000;

/** Projected USD for one request, before it is sent. Used only for ranking. */
export function projectCost(model: CatalogModel, inputTokens: number, maxOutput: number): number {
  const output = Math.min(maxOutput, model.maxOutput);
  return (inputTokens * model.inputCostPerMTok + output * model.outputCostPerMTok) / PER_MTOK;
}

/**
 * Whether the prompt plus the requested completion fits this model's window.
 * A 5% headroom absorbs the gap between our character-based estimate and the
 * provider's real tokenizer — being slightly pessimistic here costs a candidate
 * its place in the ranking, while being optimistic costs the user a hard 400.
 */
export function fitsContext(model: CatalogModel, inputTokens: number, maxOutput: number): boolean {
  const output = Math.min(maxOutput, model.maxOutput);
  return inputTokens * 1.05 + output <= model.contextWindow;
}

/** Blended per-MTok price at a 3:1 input:output ratio, for cost ceilings. */
export function blendedPrice(model: CatalogModel): number {
  return model.inputCostPerMTok * 0.75 + model.outputCostPerMTok * 0.25;
}

/** What the caller asked for, clamped to something sane when absent. */
export function requestedMaxOutput(body: Record<string, unknown>): number {
  const raw = body['max_tokens'] ?? body['max_completion_tokens'] ?? body['max_output_tokens'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return 1024;
}
