import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { TokenUsage } from '@/types/core';
import { findModel } from '@/lib/providers/registry';
import {
  BASELINE_INPUT_PER_MTOK,
  BASELINE_OUTPUT_PER_MTOK,
  computeCost,
  emptyUsage,
  estimateInputTokens,
  normalizeUsage,
  settleRequest,
} from '@/lib/usage/cost';

/** Builds a TokenUsage without repeating the four fields a case does not use. */
function tokens(partial: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...partial };
}

/** One million prompt and one million completion tokens.
 *
 * Every per-MTok price in the catalog is then readable straight off the
 * assertion: a model at $0.05 in / $0.08 out costs exactly $0.13 for this
 * request, so a wrong expectation is obvious rather than arithmetic to check.
 */
const ONE_MTOK_EACH: TokenUsage = tokens({
  promptTokens: 1_000_000,
  completionTokens: 1_000_000,
  totalTokens: 2_000_000,
});

/** Baseline for ONE_MTOK_EACH: $3.00 in + $15.00 out. */
const BASELINE_FOR_ONE_MTOK_EACH = 18;

describe('usage/cost', () => {
  beforeEach(() => {
    // Nothing in this module should touch the network; a stub that throws turns
    // a future regression into a failure here rather than a slow flake in CI.
    vi.stubGlobal('fetch', () => {
      throw new Error('cost.ts must never make a network call');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('emptyUsage', () => {
    it('is all zeros', () => {
      expect(emptyUsage()).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      });
    });

    it('returns a fresh object each call so callers cannot share a counter', () => {
      const first = emptyUsage();
      first.promptTokens = 99;
      expect(first.promptTokens).toBe(99);
      expect(emptyUsage().promptTokens).toBe(0);
    });
  });

  describe('computeCost', () => {
    describe('when there is nothing to bill', () => {
      it('returns 0 for a null model', () => {
        expect(computeCost(null, ONE_MTOK_EACH)).toBe(0);
      });

      it('returns 0 for null usage', () => {
        expect(computeCost(findModel('openai', 'gpt-4o'), null)).toBe(0);
      });

      it('returns 0 when both are null', () => {
        expect(computeCost(null, null)).toBe(0);
      });

      it('returns 0 for a real model that consumed no tokens', () => {
        expect(computeCost(findModel('openai', 'gpt-4o-mini'), emptyUsage())).toBe(0);
      });
    });

    describe('per-million-token arithmetic', () => {
      it('bills gpt-4o-mini at $0.15/MTok in and $0.60/MTok out', () => {
        // 1M prompt at 0.15 = $0.15; 0.5M completion at 0.60 = $0.30.
        const cost = computeCost(
          findModel('openai', 'gpt-4o-mini'),
          tokens({ promptTokens: 1_000_000, completionTokens: 500_000 }),
        );
        expect(cost).toBeCloseTo(0.45, 10);
      });

      it('scales linearly below a million tokens', () => {
        // Claude Sonnet 4.5: $3 in / $15 out. 2,000 in + 1,000 out.
        const cost = computeCost(
          findModel('anthropic', 'claude-sonnet-4-5-20250929'),
          tokens({ promptTokens: 2_000, completionTokens: 1_000 }),
        );
        expect(cost).toBeCloseTo(0.021, 10);
      });

      it('charges the input and output rates separately, not a blend', () => {
        // gpt-4o-mini's rates differ 4x. Swapping prompt for completion tokens
        // must change the bill; a blended rate would return the same number.
        const model = findModel('openai', 'gpt-4o-mini');
        const inputHeavy = computeCost(model, tokens({ promptTokens: 1_000_000 }));
        const outputHeavy = computeCost(model, tokens({ completionTokens: 1_000_000 }));
        expect(inputHeavy).toBeCloseTo(0.15, 10);
        expect(outputHeavy).toBeCloseTo(0.6, 10);
      });

      it('costs nothing for a model the catalog prices at zero', () => {
        // NVIDIA NIM publishes these at $0/MTok, so no arithmetic applies.
        expect(computeCost(findModel('nvidia-nim', 'meta/llama-3.3-70b-instruct'), ONE_MTOK_EACH)).toBe(
          0,
        );
      });
    });

    describe('prompt caching', () => {
      it('bills cached tokens at 10% of the input rate', () => {
        // gpt-4o-mini input is $0.15/MTok, so a fully cached 1M-token prompt is
        // $0.015.
        const cost = computeCost(
          findModel('openai', 'gpt-4o-mini'),
          tokens({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }),
        );
        expect(cost).toBeCloseTo(0.015, 10);
      });

      it('subtracts cached tokens from promptTokens rather than adding to them', () => {
        // Providers already count cached tokens inside promptTokens. If they
        // were not subtracted, a fully cached prompt would bill 1.1x the
        // uncached price instead of 0.1x — the single most expensive way to get
        // this wrong.
        const model = findModel('openai', 'gpt-4o-mini');
        const uncached = computeCost(model, tokens({ promptTokens: 1_000_000 }));
        const fullyCached = computeCost(
          model,
          tokens({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }),
        );
        expect(fullyCached).toBeCloseTo(uncached * 0.1, 10);
        expect(fullyCached).toBeLessThan(uncached);
      });

      it('bills a half-cached prompt as 50% full rate plus 50% discounted', () => {
        // 0.5M * 0.15 = 0.075, plus 0.5M * 0.15 * 0.1 = 0.0075.
        const cost = computeCost(
          findModel('openai', 'gpt-4o-mini'),
          tokens({ promptTokens: 1_000_000, cachedTokens: 500_000 }),
        );
        expect(cost).toBeCloseTo(0.0825, 10);
        // The double-counting bug would produce 0.15 + 0.0075 = 0.1575.
        expect(cost).toBeLessThan(0.1575);
      });

      it('leaves the output side untouched by the cache discount', () => {
        const model = findModel('openai', 'gpt-4o-mini');
        const cost = computeCost(
          model,
          tokens({
            promptTokens: 1_000_000,
            cachedTokens: 1_000_000,
            completionTokens: 1_000_000,
          }),
        );
        expect(cost).toBeCloseTo(0.015 + 0.6, 10);
      });

      it('never credits back more than the prompt when cachedTokens exceeds it', () => {
        // A provider reporting more cache hits than prompt tokens is nonsense,
        // but the Math.max(0, …) clamp is what keeps it from producing a
        // negative input cost and a bogus refund on the dashboard.
        const cost = computeCost(
          findModel('openai', 'gpt-4o-mini'),
          tokens({ promptTokens: 100, cachedTokens: 500 }),
        );
        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeCloseTo((500 * 0.15 * 0.1) / 1_000_000, 12);
      });

      it('is unaffected by cachedTokens on a zero-priced model', () => {
        expect(
          computeCost(
            findModel('nvidia-nim', 'meta/llama-3.1-8b-instruct'),
            tokens({ promptTokens: 1_000_000, cachedTokens: 400_000 }),
          ),
        ).toBe(0);
      });
    });

    describe('reasoning tokens', () => {
      it('bills reasoning tokens at the output rate', () => {
        // o4-mini output is $4.40/MTok.
        const cost = computeCost(
          findModel('openai', 'o4-mini'),
          tokens({ reasoningTokens: 1_000_000 }),
        );
        expect(cost).toBeCloseTo(4.4, 10);
      });

      it('treats a reasoning token exactly like a completion token', () => {
        const model = findModel('openai', 'o4-mini');
        const asCompletion = computeCost(model, tokens({ completionTokens: 50_000 }));
        const asReasoning = computeCost(model, tokens({ reasoningTokens: 50_000 }));
        expect(asReasoning).toBeCloseTo(asCompletion, 12);
      });

      it('adds reasoning to completion rather than replacing it', () => {
        // A model that emits 10k visible tokens after 90k of thinking is billed
        // for 100k of output, not 10k.
        const cost = computeCost(
          findModel('openai', 'o4-mini'),
          tokens({ completionTokens: 10_000, reasoningTokens: 90_000 }),
        );
        expect(cost).toBeCloseTo((100_000 * 4.4) / 1_000_000, 10);
      });

      it('does not bill reasoning tokens at the input rate', () => {
        // o4-mini input is $1.10 and output $4.40, so the two are impossible to
        // confuse in the assertion.
        const cost = computeCost(
          findModel('openai', 'o4-mini'),
          tokens({ reasoningTokens: 1_000_000 }),
        );
        expect(cost).not.toBeCloseTo(1.1, 6);
      });
    });
  });

  describe('settleRequest', () => {
    describe('when the request cannot be resolved', () => {
      it('returns zeros for a null providerId', () => {
        expect(settleRequest(null, 'gpt-4o', ONE_MTOK_EACH)).toEqual({ costUsd: 0, savedUsd: 0 });
      });

      it('returns zeros for a null modelId', () => {
        expect(settleRequest('openai', null, ONE_MTOK_EACH)).toEqual({ costUsd: 0, savedUsd: 0 });
      });

      it('returns zeros for null usage', () => {
        expect(settleRequest('openai', 'gpt-4o', null)).toEqual({ costUsd: 0, savedUsd: 0 });
      });

      it('returns zeros for a provider that is not in the catalog', () => {
        expect(settleRequest('not-a-provider', 'gpt-4o', ONE_MTOK_EACH)).toEqual({
          costUsd: 0,
          savedUsd: 0,
        });
      });

      it('returns zeros for a model the provider does not list', () => {
        expect(settleRequest('openai', 'claude-opus-4-5-20251101', ONE_MTOK_EACH)).toEqual({
          costUsd: 0,
          savedUsd: 0,
        });
      });

      it('claims no saving for an unresolved model even though tokens were spent', () => {
        // Reporting the full baseline as "saved" here would invent a number for
        // traffic nothing can be attributed to.
        expect(settleRequest('openai', 'no-such-model', ONE_MTOK_EACH).savedUsd).toBe(0);
      });

      it('resolves a model id regardless of case or surrounding whitespace', () => {
        const canonical = settleRequest('openai', 'gpt-4o-mini', ONE_MTOK_EACH);
        expect(settleRequest('openai', '  GPT-4O-Mini  ', ONE_MTOK_EACH)).toEqual(canonical);
        expect(canonical.costUsd).toBeGreaterThan(0);
      });
    });

    describe('free-tier coverage', () => {
      it('settles a free-tier model at $0 even though the catalog prices it', () => {
        // Groq lists llama-3.1-8b-instant at $0.05/$0.08 but serves 14,400
        // req/day for nothing. Billing the list price would inflate the
        // dashboard with money the user never paid.
        const model = findModel('groq', 'llama-3.1-8b-instant');
        expect(model).not.toBeNull();
        expect(model?.inputCostPerMTok).toBeGreaterThan(0);
        expect(computeCost(model, ONE_MTOK_EACH)).toBeCloseTo(0.13, 10);

        expect(settleRequest('groq', 'llama-3.1-8b-instant', ONE_MTOK_EACH).costUsd).toBe(0);
      });

      it("counts the whole paid baseline as saved when the request was free", () => {
        expect(settleRequest('groq', 'llama-3.1-8b-instant', ONE_MTOK_EACH).savedUsd).toBeCloseTo(
          BASELINE_FOR_ONE_MTOK_EACH,
          10,
        );
      });

      it('covers a mid-sized model whose blended cost is under the threshold', () => {
        // Gemini 2.5 Flash blends to (0.30*3 + 2.50)/4 = 0.85.
        expect(settleRequest('google', 'gemini-2.5-flash', ONE_MTOK_EACH).costUsd).toBe(0);
      });

      it('covers a model sitting exactly on the $1.00 blended threshold', () => {
        // Cerebras GLM 4.6: (0.60*3 + 2.20)/4 = 1.00 exactly. The comparison is
        // inclusive, so this is the last model the free tier is assumed to cover.
        const model = findModel('cerebras', 'zai-glm-4.6');
        expect(model?.inputCostPerMTok).toBe(0.6);
        expect(model?.outputCostPerMTok).toBe(2.2);
        expect(settleRequest('cerebras', 'zai-glm-4.6', ONE_MTOK_EACH).costUsd).toBe(0);
      });

      it('covers a zero-priced model even at a provider with no free tier', () => {
        // Together has freeTier: null, but FLUX.1 schnell is genuinely $0/$0,
        // so the price check short-circuits before the free-tier check.
        expect(
          settleRequest('together', 'black-forest-labs/FLUX.1-schnell-Free', ONE_MTOK_EACH).costUsd,
        ).toBe(0);
      });

      it('keeps a free-tier request at $0 no matter how many tokens it used', () => {
        const heavy = tokens({
          promptTokens: 500_000_000,
          completionTokens: 500_000_000,
          totalTokens: 1_000_000_000,
        });
        expect(settleRequest('groq', 'llama-3.3-70b-versatile', heavy).costUsd).toBe(0);
      });
    });

    describe('above the free-tier threshold', () => {
      it('bills a flagship model on a free-tier provider', () => {
        // Gemini 2.5 Pro blends to (1.25*3 + 10)/4 = 3.44, well past $1.00.
        // Google's free tier is published against Flash, not Pro.
        const settled = settleRequest('google', 'gemini-2.5-pro', ONE_MTOK_EACH);
        expect(settled.costUsd).toBeCloseTo(11.25, 10);
      });

      it('bills the first Groq model past the threshold', () => {
        // Kimi K2 blends to (1.00*3 + 3.00)/4 = 1.50.
        const settled = settleRequest('groq', 'moonshotai/kimi-k2-instruct-0905', ONE_MTOK_EACH);
        expect(settled.costUsd).toBeCloseTo(4, 10);
      });

      it('still records a saving when a billed model beats the baseline', () => {
        const settled = settleRequest('google', 'gemini-2.5-pro', ONE_MTOK_EACH);
        expect(settled.savedUsd).toBeCloseTo(BASELINE_FOR_ONE_MTOK_EACH - 11.25, 10);
      });

      it('matches computeCost exactly for a billed model', () => {
        const model = findModel('google', 'gemini-2.5-pro');
        expect(settleRequest('google', 'gemini-2.5-pro', ONE_MTOK_EACH).costUsd).toBe(
          computeCost(model, ONE_MTOK_EACH),
        );
      });
    });

    describe('providers with no free tier', () => {
      it('bills a cheap model when the provider publishes no free allowance', () => {
        // deepseek-chat blends to (0.27*3 + 1.10)/4 = 0.48 — under the $1.00
        // threshold — but DeepSeek has freeTier: null, so it is billed anyway.
        // The threshold only ever applies on top of a published allowance.
        const settled = settleRequest('deepseek', 'deepseek-chat', ONE_MTOK_EACH);
        expect(settled.costUsd).toBeCloseTo(1.37, 10);
      });

      it('bills OpenAI at list price', () => {
        expect(settleRequest('openai', 'gpt-4o-mini', ONE_MTOK_EACH).costUsd).toBeCloseTo(0.75, 10);
      });

      it('bills Anthropic at list price', () => {
        expect(
          settleRequest('anthropic', 'claude-haiku-4-5-20251001', ONE_MTOK_EACH).costUsd,
        ).toBeCloseTo(6, 10);
      });

      it('applies the cache discount to a billed provider', () => {
        const settled = settleRequest(
          'openai',
          'gpt-4o-mini',
          tokens({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }),
        );
        expect(settled.costUsd).toBeCloseTo(0.015, 10);
      });
    });

    describe('the savings baseline', () => {
      it('measures against $3.00 in and $15.00 out per MTok', () => {
        expect(BASELINE_INPUT_PER_MTOK).toBe(3.0);
        expect(BASELINE_OUTPUT_PER_MTOK).toBe(15.0);
      });

      it('reports zero saved when the model costs exactly the baseline', () => {
        // Claude Sonnet 4.5 is priced at $3/$15 — the baseline itself.
        const settled = settleRequest('anthropic', 'claude-sonnet-4-5-20250929', ONE_MTOK_EACH);
        expect(settled.costUsd).toBeCloseTo(BASELINE_FOR_ONE_MTOK_EACH, 10);
        expect(settled.savedUsd).toBe(0);
      });

      it('never reports a negative saving for a model above the baseline', () => {
        // Quality-first routing genuinely picks models that cost more. That is a
        // real outcome, but it is not a negative saving.
        const settled = settleRequest('anthropic', 'claude-opus-4-1-20250805', ONE_MTOK_EACH);
        expect(settled.costUsd).toBeCloseTo(90, 10);
        expect(settled.savedUsd).toBe(0);
      });

      it('never reports a negative saving for the most expensive catalog entry', () => {
        const settled = settleRequest(
          'openai',
          'gpt-image-1',
          tokens({ promptTokens: 1_000_000, completionTokens: 1_000_000 }),
        );
        expect(settled.costUsd).toBeGreaterThan(BASELINE_FOR_ONE_MTOK_EACH);
        expect(settled.savedUsd).toBe(0);
      });

      it('counts reasoning tokens into the baseline at the output rate', () => {
        // Otherwise a reasoning model would look like it saved less than it did.
        const settled = settleRequest(
          'groq',
          'llama-3.1-8b-instant',
          tokens({ completionTokens: 0, reasoningTokens: 1_000_000 }),
        );
        expect(settled.savedUsd).toBeCloseTo(15, 10);
      });

      it('measures the baseline on raw prompt tokens, cache discount included', () => {
        // The baseline answers "what would a premium model have charged", and it
        // would have charged for the whole prompt.
        const settled = settleRequest(
          'openai',
          'gpt-4o-mini',
          tokens({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }),
        );
        expect(settled.savedUsd).toBeCloseTo(3 - 0.015, 10);
      });

      it('reports zero cost and zero saving for a request that used no tokens', () => {
        expect(settleRequest('openai', 'gpt-4o', emptyUsage())).toEqual({
          costUsd: 0,
          savedUsd: 0,
        });
      });
    });
  });

  describe('estimateInputTokens', () => {
    describe('empty and trivial bodies', () => {
      it('returns 0 for an empty body', () => {
        expect(estimateInputTokens({})).toBe(0);
      });

      it('returns 0 for an empty messages array', () => {
        expect(estimateInputTokens({ messages: [] })).toBe(0);
      });

      it('returns 0 for a body with no recognised fields', () => {
        expect(estimateInputTokens({ model: 'gpt-4o', temperature: 0.7, stream: true })).toBe(0);
      });

      it('always returns a whole number of tokens', () => {
        const estimate = estimateInputTokens({
          messages: [{ role: 'user', content: 'seven chars' }],
        });
        expect(Number.isInteger(estimate)).toBe(true);
      });
    });

    describe('chat messages', () => {
      it('counts message text plus a small per-message overhead', () => {
        // 5 chars + 12 chars of role/delimiter overhead, at 3.6 chars/token.
        expect(estimateInputTokens({ messages: [{ role: 'user', content: 'hello' }] })).toBe(5);
      });

      it('charges the per-message overhead even for empty content', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user', content: '' }] })).toBe(4);
      });

      it('charges the overhead once per message', () => {
        // Five empty messages: 60 chars of overhead / 3.6.
        const five = [
          { role: 'user', content: '' },
          { role: 'assistant', content: '' },
          { role: 'user', content: '' },
          { role: 'assistant', content: '' },
          { role: 'user', content: '' },
        ];
        expect(estimateInputTokens({ messages: five })).toBe(17);
      });

      it('grows monotonically with message length', () => {
        const short = estimateInputTokens({
          messages: [{ role: 'user', content: 'a'.repeat(100) }],
        });
        const medium = estimateInputTokens({
          messages: [{ role: 'user', content: 'a'.repeat(1_000) }],
        });
        const long = estimateInputTokens({
          messages: [{ role: 'user', content: 'a'.repeat(10_000) }],
        });
        expect(short).toBe(32);
        expect(medium).toBe(282);
        expect(long).toBe(2_782);
        expect(short).toBeLessThan(medium);
        expect(medium).toBeLessThan(long);
      });

      it('grows with the number of messages', () => {
        const one = estimateInputTokens({ messages: [{ role: 'user', content: 'a'.repeat(360) }] });
        const two = estimateInputTokens({
          messages: [
            { role: 'user', content: 'a'.repeat(360) },
            { role: 'assistant', content: 'a'.repeat(360) },
          ],
        });
        expect(two).toBeGreaterThan(one);
      });

      it('counts OpenAI-style text content parts', () => {
        expect(
          estimateInputTokens({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
          }),
        ).toBe(4);
      });

      it('counts a system message alongside the conversation', () => {
        const withoutSystem = estimateInputTokens({
          messages: [{ role: 'user', content: 'hello' }],
        });
        const withSystem = estimateInputTokens({
          messages: [{ role: 'user', content: 'hello' }],
          system: 'You are a helpful assistant that answers concisely.',
        });
        expect(withSystem).toBeGreaterThan(withoutSystem);
      });

      it('counts a top-level system string on its own', () => {
        // "You are helpful." is 16 chars.
        expect(estimateInputTokens({ system: 'You are helpful.' })).toBe(5);
      });
    });

    describe('image parts', () => {
      const textPart = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      };

      it('adds a flat 800 tokens for one image part', () => {
        const withImage = estimateInputTokens({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
            },
          ],
        });
        expect(withImage).toBe(804);
        expect(withImage - estimateInputTokens(textPart)).toBe(800);
      });

      it('ignores the image payload length', () => {
        // A base64 data URL is enormous but says nothing about token cost — the
        // early return is what stops a 5KB URL from being counted as prose.
        const huge = `data:image/png;base64,${'A'.repeat(500_000)}`;
        expect(
          estimateInputTokens({
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: huge } }] }],
          }),
        ).toBe(804);
      });

      it("recognises Anthropic's { type: 'image' } shape", () => {
        expect(
          estimateInputTokens({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
                ],
              },
            ],
          }),
        ).toBe(804);
      });

      it('recognises a part carrying image_url with no type field', () => {
        expect(
          estimateInputTokens({
            messages: [
              { role: 'user', content: [{ image_url: { url: 'https://example.com/a.png' } }] },
            ],
          }),
        ).toBe(804);
      });

      it('charges per image, not per message', () => {
        expect(
          estimateInputTokens({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
                  { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
                ],
              },
            ],
          }),
        ).toBe(1_604);
      });

      it('counts text and images in the same message', () => {
        const mixed = estimateInputTokens({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'a'.repeat(360) },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
              ],
            },
          ],
        });
        // 372 chars / 3.6 = 104 tokens, plus the flat 800.
        expect(mixed).toBe(904);
      });
    });

    describe('non-chat request shapes', () => {
      it('counts an embeddings `input` string', () => {
        expect(estimateInputTokens({ input: 'hello world' })).toBe(4);
      });

      it('counts an embeddings `input` array', () => {
        expect(estimateInputTokens({ input: ['aaa', 'bbb'] })).toBe(2);
      });

      it('counts a legacy completions `prompt` string', () => {
        expect(estimateInputTokens({ prompt: 'hello world' })).toBe(4);
      });

      it('treats `input` and `prompt` identically', () => {
        expect(estimateInputTokens({ input: 'same text here' })).toBe(
          estimateInputTokens({ prompt: 'same text here' }),
        );
      });

      it('grows with the size of an embeddings batch', () => {
        const small = estimateInputTokens({ input: ['a'.repeat(100)] });
        const large = estimateInputTokens({ input: Array.from({ length: 20 }, () => 'a'.repeat(100)) });
        expect(large).toBeGreaterThan(small);
      });
    });

    describe('tool definitions', () => {
      it('counts the serialized tool schema', () => {
        // JSON.stringify([{"name":"get_weather"}]) is 24 chars / 3.6 = 7.
        expect(estimateInputTokens({ tools: [{ name: 'get_weather' }] })).toBe(7);
      });

      it('makes a request with tools more expensive than the same one without', () => {
        const base = { messages: [{ role: 'user', content: 'what is the weather?' }] };
        const withTools = {
          ...base,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Look up the current weather for a city',
                parameters: { type: 'object', properties: { city: { type: 'string' } } },
              },
            },
          ],
        };
        expect(estimateInputTokens(withTools)).toBeGreaterThan(estimateInputTokens(base));
      });

      it('ignores a non-array tools field', () => {
        expect(estimateInputTokens({ tools: 'auto' })).toBe(0);
      });
    });

    describe('malformed bodies', () => {
      it('ignores a non-array messages field', () => {
        expect(estimateInputTokens({ messages: 'not an array' })).toBe(0);
        expect(estimateInputTokens({ messages: null })).toBe(0);
        expect(estimateInputTokens({ messages: 42 })).toBe(0);
      });

      it('skips entries in messages that are not objects', () => {
        expect(estimateInputTokens({ messages: [null, 42, 'raw string', true] })).toBe(0);
      });

      it('handles a message with no content field', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user' }] })).toBe(4);
      });

      it('handles null content', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user', content: null }] })).toBe(4);
      });

      it('handles numeric content', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user', content: 42 }] })).toBe(4);
      });

      it('handles an empty content array', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user', content: [] }] })).toBe(4);
      });

      it('walks arbitrarily nested arrays', () => {
        // 'deep text' is 9 chars, plus the 12-char message overhead.
        expect(
          estimateInputTokens({ messages: [{ role: 'user', content: [[['deep text']]] }] }),
        ).toBe(6);
      });

      it('charges unknown objects their serialized size rather than dropping them', () => {
        // '{"nested":{"a":1}}' is 18 chars / 3.6 = 5.
        expect(estimateInputTokens({ input: { nested: { a: 1 } } })).toBe(5);
      });

      it('follows a nested content field on an unknown object', () => {
        expect(estimateInputTokens({ input: { content: 'hello world' } })).toBe(4);
      });

      it('does not throw on a body of every wrong type at once', () => {
        expect(() =>
          estimateInputTokens({
            messages: [null, 7, { content: [null, 3, [{ text: 5 }]] }],
            input: [[null]],
            prompt: false,
            system: 12,
            tools: null,
          }),
        ).not.toThrow();
      });

      it('never returns a negative estimate', () => {
        expect(estimateInputTokens({ messages: [{ role: 'user', content: '' }] })).toBeGreaterThanOrEqual(
          0,
        );
        expect(estimateInputTokens({ input: -1 })).toBe(0);
      });
    });
  });

  describe('normalizeUsage', () => {
    describe('recognised shapes', () => {
      it('reads the OpenAI prompt_tokens/completion_tokens shape', () => {
        expect(normalizeUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })).toEqual({
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          cachedTokens: 0,
          reasoningTokens: 0,
        });
      });

      it('reads the newer input_tokens/output_tokens shape', () => {
        expect(normalizeUsage({ input_tokens: 120, output_tokens: 30 })).toEqual({
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          cachedTokens: 0,
          reasoningTokens: 0,
        });
      });

      it('reads an already-camelCased shape', () => {
        expect(normalizeUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10 })).toEqual({
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          cachedTokens: 0,
          reasoningTokens: 0,
        });
      });

      it('prefers prompt_tokens when a response carries both spellings', () => {
        const usage = normalizeUsage({ prompt_tokens: 100, input_tokens: 999, completion_tokens: 1 });
        expect(usage?.promptTokens).toBe(100);
      });
    });

    describe('cached tokens', () => {
      it('reads prompt_tokens_details.cached_tokens', () => {
        const usage = normalizeUsage({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 60 },
        });
        expect(usage?.cachedTokens).toBe(60);
      });

      it("reads Anthropic's cache_read_input_tokens", () => {
        const usage = normalizeUsage({
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 80,
        });
        expect(usage?.cachedTokens).toBe(80);
      });

      it('reads a flat cached_tokens key', () => {
        const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 25 });
        expect(usage?.cachedTokens).toBe(25);
      });

      it('falls back to the flat key when the nested one reports zero', () => {
        // Some gateways emit an empty details object alongside the real number.
        const usage = normalizeUsage({
          prompt_tokens: 100,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 0 },
          cache_read_input_tokens: 42,
        });
        expect(usage?.cachedTokens).toBe(42);
      });

      it('reports zero cached tokens when no cache key is present', () => {
        expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 })?.cachedTokens).toBe(0);
      });

      it('ignores a details field that is not an object', () => {
        expect(
          normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: null })
            ?.cachedTokens,
        ).toBe(0);
        expect(
          normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: 'n/a' })
            ?.cachedTokens,
        ).toBe(0);
      });
    });

    describe('reasoning tokens', () => {
      it('reads completion_tokens_details.reasoning_tokens', () => {
        const usage = normalizeUsage({
          prompt_tokens: 10,
          completion_tokens: 500,
          completion_tokens_details: { reasoning_tokens: 480 },
        });
        expect(usage?.reasoningTokens).toBe(480);
      });

      it('reads a flat reasoning_tokens key', () => {
        expect(
          normalizeUsage({ prompt_tokens: 10, completion_tokens: 500, reasoning_tokens: 480 })
            ?.reasoningTokens,
        ).toBe(480);
      });

      it('reports zero reasoning tokens for a non-reasoning response', () => {
        expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 })?.reasoningTokens).toBe(0);
      });
    });

    describe('total tokens', () => {
      it('computes the total when the provider omits it', () => {
        expect(normalizeUsage({ prompt_tokens: 41, completion_tokens: 1 })?.totalTokens).toBe(42);
      });

      it('recomputes the total when the provider reports it as zero', () => {
        expect(
          normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 0 })?.totalTokens,
        ).toBe(15);
      });

      it('trusts a provider total that disagrees with the sum', () => {
        // Anthropic counts cache-creation tokens outside the two headline
        // numbers, so the reported total is the authoritative one.
        expect(
          normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 })?.totalTokens,
        ).toBe(999);
      });

      it('keeps a usage object when only the total is reported', () => {
        expect(normalizeUsage({ total_tokens: 42 })).toEqual({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 42,
          cachedTokens: 0,
          reasoningTokens: 0,
        });
      });
    });

    describe('nothing usable', () => {
      it('returns null for null', () => {
        expect(normalizeUsage(null)).toBeNull();
      });

      it('returns null for undefined', () => {
        expect(normalizeUsage(undefined)).toBeNull();
      });

      it('returns null for a primitive', () => {
        expect(normalizeUsage('usage')).toBeNull();
        expect(normalizeUsage(42)).toBeNull();
        expect(normalizeUsage(true)).toBeNull();
      });

      it('returns null for an empty object', () => {
        expect(normalizeUsage({})).toBeNull();
      });

      it('returns null when no recognised key carries a number', () => {
        expect(normalizeUsage({ foo: 'bar', prompt_tokens: '100' })).toBeNull();
      });

      it('returns null rather than a zeroed object, so callers can tell the difference', () => {
        // A null return means "the provider reported no usage". Anything else is
        // a real measurement the dashboard can add up.
        const missing = normalizeUsage({ id: 'chatcmpl-1' });
        expect(missing).toBeNull();
        expect(missing).not.toEqual(emptyUsage());
      });

      it('treats an explicitly all-zero report as no usage', () => {
        expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
      });

      it('ignores non-finite numbers and falls through to the next key', () => {
        const usage = normalizeUsage({
          prompt_tokens: Number.NaN,
          input_tokens: 55,
          completion_tokens: 5,
        });
        expect(usage?.promptTokens).toBe(55);
      });

      it('ignores Infinity', () => {
        expect(
          normalizeUsage({ prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 5 })
            ?.promptTokens,
        ).toBe(0);
      });
    });

    describe('feeding computeCost', () => {
      it('produces a usage object the cost model bills correctly', () => {
        const usage = normalizeUsage({
          prompt_tokens: 1_000_000,
          completion_tokens: 1_000_000,
          prompt_tokens_details: { cached_tokens: 1_000_000 },
        });
        expect(usage).not.toBeNull();
        // Whole prompt cached: 0.15 * 0.1 = 0.015, plus 0.60 of output.
        expect(computeCost(findModel('openai', 'gpt-4o-mini'), usage)).toBeCloseTo(0.615, 10);
      });

      it('settles an unreported usage as zero cost', () => {
        expect(settleRequest('openai', 'gpt-4o', normalizeUsage(undefined))).toEqual({
          costUsd: 0,
          savedUsd: 0,
        });
      });
    });
  });
});
