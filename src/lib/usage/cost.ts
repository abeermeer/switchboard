import type { CatalogModel, TokenUsage } from '@/types/core';
import { findModel, getProvider, isCoveredByFreeTier } from '@/lib/providers/registry';

/**
 * The paid baseline savings are measured against: roughly what a frontier model
 * costs today. Every "saved" figure in the dashboard answers one question —
 * what would this exact traffic have cost if it had all gone to a premium model
 * instead of being routed?
 */
export const BASELINE_INPUT_PER_MTOK = 3.0;
export const BASELINE_OUTPUT_PER_MTOK = 15.0;

/**
 * Providers bill cached prompt tokens at a steep discount. 10% is the common
 * rate across OpenAI, Anthropic and DeepSeek; using one blended figure keeps
 * the estimate honest without modelling each provider's cache pricing.
 */
const CACHE_DISCOUNT = 0.1;

const PER_MTOK = 1_000_000;

export function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/** What this request actually cost, in USD. */
export function computeCost(model: CatalogModel | null, usage: TokenUsage | null): number {
  if (model === null || usage === null) return 0;

  // Cached tokens are already counted inside promptTokens by every provider
  // that reports them, so they must be subtracted before billing at full rate.
  const billedPrompt = Math.max(0, usage.promptTokens - usage.cachedTokens);
  const billedOutput = usage.completionTokens + usage.reasoningTokens;

  const inputCost =
    (billedPrompt * model.inputCostPerMTok + usage.cachedTokens * model.inputCostPerMTok * CACHE_DISCOUNT) /
    PER_MTOK;
  const outputCost = (billedOutput * model.outputCostPerMTok) / PER_MTOK;

  return inputCost + outputCost;
}

/**
 * Cost and savings for a request that actually ran, resolved through the
 * provider that served it.
 *
 * A model covered by a provider's free allowance is billed at $0 — reporting
 * its list price would inflate the dashboard's headline spend with money the
 * user never paid.
 */
export function settleRequest(
  providerId: string | null,
  modelId: string | null,
  usage: TokenUsage | null,
): { costUsd: number; savedUsd: number } {
  if (providerId === null || modelId === null || usage === null) {
    return { costUsd: 0, savedUsd: 0 };
  }

  const provider = getProvider(providerId);
  const model = findModel(providerId, modelId);
  if (provider === null || model === null) return { costUsd: 0, savedUsd: 0 };

  const costUsd = isCoveredByFreeTier(provider, model) ? 0 : computeCost(model, usage);

  const billedOutput = usage.completionTokens + usage.reasoningTokens;
  const baseline =
    (usage.promptTokens * BASELINE_INPUT_PER_MTOK + billedOutput * BASELINE_OUTPUT_PER_MTOK) /
    PER_MTOK;

  // Routing above the baseline is a real outcome — quality-first does exactly
  // that — but it is not a negative saving.
  return { costUsd, savedUsd: Math.max(0, baseline - costUsd) };
}

/** Average characters per token across English prose and code. */
const CHARS_PER_TOKEN = 3.6;

/** Rough token cost of one image part, before any provider-specific tiling. */
const TOKENS_PER_IMAGE = 800;

/**
 * A deliberately cheap input-size estimate. It only has to rank candidates and
 * check context fit before the request goes out — the real count comes back
 * from the provider, and that is what gets billed and logged.
 */
export function estimateInputTokens(body: Record<string, unknown>): number {
  let chars = 0;
  let images = 0;

  const countValue = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const part of value) countValue(part);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const part = value as Record<string, unknown>;
      if (part['type'] === 'image_url' || part['type'] === 'image' || 'image_url' in part) {
        images += 1;
        return;
      }
      if (typeof part['text'] === 'string') {
        chars += (part['text'] as string).length;
        return;
      }
      if (typeof part['content'] === 'string' || Array.isArray(part['content'])) {
        countValue(part['content']);
        return;
      }
      // Tool definitions and unknown objects still consume context.
      chars += JSON.stringify(part).length;
    }
  };

  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue;
      countValue((message as Record<string, unknown>)['content']);
      // Every message carries a few tokens of role/delimiter overhead.
      chars += 12;
    }
  }

  countValue(body['input']);
  countValue(body['prompt']);
  countValue(body['system']);
  if (Array.isArray(body['tools'])) chars += JSON.stringify(body['tools']).length;

  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

/** Normalizes the several shapes providers use to report token usage. */
export function normalizeUsage(raw: unknown): TokenUsage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;

  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = u[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };

  const nested = (outer: string, inner: string): number => {
    const container = u[outer];
    if (container === null || typeof container !== 'object') return 0;
    const value = (container as Record<string, unknown>)[inner];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  const promptTokens = num('prompt_tokens', 'input_tokens', 'promptTokens');
  const completionTokens = num('completion_tokens', 'output_tokens', 'completionTokens');
  const cachedTokens =
    nested('prompt_tokens_details', 'cached_tokens') ||
    num('cache_read_input_tokens', 'cached_tokens');
  const reasoningTokens =
    nested('completion_tokens_details', 'reasoning_tokens') || num('reasoning_tokens');

  const totalTokens = num('total_tokens', 'totalTokens') || promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;

  return { promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens };
}
