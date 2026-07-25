import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { CatalogModel, ChatFeature, Modality } from '@/types/core';
import type { ExpandInput } from '@/lib/router/candidates';
import { expandCandidates, memberOrderMap } from '@/lib/router/candidates';
import {
  blendedPrice,
  fitsContext,
  projectCost,
  requestedMaxOutput,
} from '@/lib/router/estimate';
import { createConnection, updateConnection } from '@/lib/db/repos/connections';
import { setCredential } from '@/lib/db/repos/credentials';
import { createCombo, updateCombo } from '@/lib/db/repos/combos';
import { defaultHealthRow, setLockout, upsertHealthRow } from '@/lib/db/repos/health';
import { recordUsageBucket } from '@/lib/db/repos/usage';
import { findModel } from '@/lib/providers/registry';
import { dropDb, freshDb } from '../helpers/db';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** An ExpandInput with sane defaults; override only the field under test. */
function ex(requestedModel: string, overrides: Partial<ExpandInput> = {}): ExpandInput {
  return {
    modality: 'chat',
    requestedModel,
    inputTokens: 1_000,
    maxOutput: 1_024,
    requiredFeatures: [],
    freeOnly: false,
    apiKey: null,
    ...overrides,
  };
}

/** Creates a connection for a real catalog provider and seals a credential. */
function connect(providerId: string): string {
  const conn = createConnection({ providerId });
  setCredential(conn.id, `sk-test-${conn.id}`);
  return conn.id;
}

/** A synthetic model, for exercising estimate.ts at exact boundaries. */
function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'test-model',
    name: 'Test Model',
    modality: 'chat',
    features: ['streaming'],
    contextWindow: 1_000,
    maxOutput: 1_000,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
    throughputPrior: 100,
    ...overrides,
  };
}

// ─── candidates.ts ───────────────────────────────────────────────────────────

describe('router/expandCandidates', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
  });

  afterEach(() => {
    dropDb(dir);
  });

  describe('model string resolution', () => {
    it('resolves a combo slug to that combo\'s explicit members only', () => {
      const groq = connect('groq');
      connect('openai'); // present but not a member — must not appear
      createCombo({
        slug: 'coder',
        name: 'Coder',
        members: [{ connectionId: groq, modelId: 'llama-3.1-8b-instant', order: 0, weight: 1, enabled: true }],
      });

      const res = expandCandidates(ex('coder'));

      expect(res.combo?.slug).toBe('coder');
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.connectionId).toBe(groq);
      expect(res.candidates[0]?.modelId).toBe('llama-3.1-8b-instant');
      expect(res.candidates.some((c) => c.providerId === 'openai')).toBe(false);
    });

    it('expands a combo member with a "*" model to every chat model of its provider', () => {
      const groq = connect('groq');
      createCombo({
        slug: 'all-groq',
        name: 'All Groq',
        members: [{ connectionId: groq, modelId: '*', order: 0, weight: 1, enabled: true }],
      });

      const res = expandCandidates(ex('all-groq'));

      // Groq publishes eight chat models (the ninth entry is a transcription model).
      expect(res.candidates).toHaveLength(8);
      expect(res.candidates.every((c) => c.connectionId === groq)).toBe(true);
      expect(res.candidates.every((c) => c.modelId !== 'whisper-large-v3-turbo')).toBe(true);
    });

    it('skips a disabled combo member rather than expanding it', () => {
      const groq = connect('groq');
      createCombo({
        slug: 'partly-off',
        name: 'Partly off',
        members: [
          { connectionId: groq, modelId: 'llama-3.1-8b-instant', order: 0, weight: 1, enabled: false },
          { connectionId: groq, modelId: 'llama-3.3-70b-versatile', order: 1, weight: 1, enabled: true },
        ],
      });

      const res = expandCandidates(ex('partly-off'));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.modelId).toBe('llama-3.3-70b-versatile');
    });

    it('treats an empty member chain as "consider every eligible connection"', () => {
      // The deliberate default: a combo with no members fans out across the fleet
      // rather than resolving to nothing.
      const groq = connect('groq');
      const openai = connect('openai');
      createCombo({ slug: 'auto', name: 'Auto', members: [] });

      const res = expandCandidates(ex('auto'));

      const connectionIds = new Set(res.candidates.map((c) => c.connectionId));
      expect(connectionIds.has(groq)).toBe(true);
      expect(connectionIds.has(openai)).toBe(true);
      // More candidates than any single provider contributes, i.e. genuinely the fleet.
      expect(res.candidates.length).toBeGreaterThan(8);
    });

    it('falls through "auto" to the default combo when no combo is named "auto"', () => {
      connect('groq');
      const primary = createCombo({ slug: 'primary', name: 'Primary', members: [] });
      updateCombo(primary.id, { isDefault: true });

      expect(expandCandidates(ex('auto')).combo?.slug).toBe('primary');
    });

    it('falls through an unrecognised model string to the default combo', () => {
      connect('groq');
      const primary = createCombo({ slug: 'primary', name: 'Primary', members: [] });
      updateCombo(primary.id, { isDefault: true });

      expect(expandCandidates(ex('nonsense-model-xyz')).combo?.slug).toBe('primary');
    });

    it('falls through a disabled combo slug to the default combo', () => {
      connect('groq');
      const primary = createCombo({ slug: 'primary', name: 'Primary', members: [] });
      updateCombo(primary.id, { isDefault: true });
      const off = createCombo({ slug: 'off', name: 'Off', members: [] });
      updateCombo(off.id, { enabled: false });

      expect(expandCandidates(ex('off')).combo?.slug).toBe('primary');
    });

    it('does not adopt the default combo when its modality differs from the request', () => {
      // The default policy only applies to the modality it was written for.
      connect('google');
      const primary = createCombo({ slug: 'primary', name: 'Primary', modality: 'chat', members: [] });
      updateCombo(primary.id, { isDefault: true });

      const res = expandCandidates(ex('unknown', { modality: 'embeddings' }));

      expect(res.combo).toBeNull();
      expect(res.hardError).toBeNull();
    });

    it('pins "provider/model" to the provider but spreads across every connection for it', () => {
      // Two keys for the same provider: the second is what makes it a failover.
      const groqA = connect('groq');
      const groqB = connect('groq');

      const res = expandCandidates(ex('groq/llama-3.3-70b-versatile'));

      expect(res.combo).toBeNull();
      expect(res.candidates).toHaveLength(2);
      expect(new Set(res.candidates.map((c) => c.connectionId))).toEqual(new Set([groqA, groqB]));
      expect(res.candidates.every((c) => c.providerId === 'groq')).toBe(true);
      expect(res.candidates.every((c) => c.modelId === 'llama-3.3-70b-versatile')).toBe(true);
      expect(res.candidates.every((c) => c.excludedReason === null)).toBe(true);
    });

    it('returns a hardError for "provider/model" naming a model the provider does not offer', () => {
      connect('groq');

      const res = expandCandidates(ex('groq/not-a-real-model'));

      expect(res.hardError).toBe('Model "not-a-real-model" is not available on Groq.');
      expect(res.candidates).toEqual([]);
    });

    it('returns a hardError for "provider/model" when no connection is configured for the provider', () => {
      connect('openai'); // some other provider, but nothing for groq

      const res = expandCandidates(ex('groq/llama-3.3-70b-versatile'));

      expect(res.hardError).toBe('No connection is configured for Groq.');
      expect(res.candidates).toEqual([]);
    });

    it('does not hardError when the slash prefix is not a known provider id', () => {
      // "vendor/model" for an unknown vendor is not a pin; it falls through to the
      // bare-name and then fleet logic instead of failing the request.
      connect('groq');

      const res = expandCandidates(ex('acme-labs/mystery-model'));

      expect(res.hardError).toBeNull();
      // Nothing matched by name, so the whole groq chat fleet is considered.
      expect(res.candidates).toHaveLength(8);
    });

    it('expands a bare model id to a single connection offering it', () => {
      const groq = connect('groq');

      const res = expandCandidates(ex('llama-3.1-8b-instant'));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.connectionId).toBe(groq);
      expect(res.candidates[0]?.modelId).toBe('llama-3.1-8b-instant');
    });

    it('expands a bare model id across every provider that offers it', () => {
      // The same id lives on both Together and Hyperbolic; a bare request should
      // survive either provider going down.
      const together = connect('together');
      const hyperbolic = connect('hyperbolic');

      const res = expandCandidates(ex('deepseek-ai/DeepSeek-V3'));

      expect(res.candidates).toHaveLength(2);
      expect(new Set(res.candidates.map((c) => c.providerId))).toEqual(
        new Set(['together', 'hyperbolic']),
      );
      expect(new Set(res.candidates.map((c) => c.connectionId))).toEqual(
        new Set([together, hyperbolic]),
      );
      expect(res.candidates.every((c) => c.excludedReason === null)).toBe(true);
    });

    it('matches a bare model id case-insensitively', () => {
      connect('together');

      const res = expandCandidates(ex('DEEPSEEK-AI/deepseek-v3'));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.modelId).toBe('deepseek-ai/DeepSeek-V3');
    });
  });

  describe('candidate cost projection', () => {
    it('prices a free-tier candidate at zero', () => {
      connect('groq');

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates[0]?.tier).toBe('free');
      expect(res.candidates[0]?.projectedCostUsd).toBe(0);
    });

    it('projects a real cost for a paid candidate', () => {
      connect('openai');

      const res = expandCandidates(ex('openai/gpt-4o'));

      const gpt4o = findModel('openai', 'gpt-4o');
      expect(gpt4o).not.toBeNull();
      expect(res.candidates[0]?.tier).not.toBe('free');
      expect(res.candidates[0]?.projectedCostUsd).toBeCloseTo(
        projectCost(gpt4o!, 1_000, 1_024),
        10,
      );
      expect(res.candidates[0]?.projectedCostUsd).toBeGreaterThan(0);
    });
  });

  // Every exclusion must be recorded with a specific reason, never silently
  // dropped: the decision trace is only useful if it can say what lost and why.
  describe('exclusion reasons', () => {
    it('excludes a disabled connection', () => {
      const groq = connect('groq');
      updateConnection(groq, { enabled: false });

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.excludedReason).toBe('Connection is disabled');
    });

    it('excludes a connection with no API key configured', () => {
      // A connection without a sealed credential — deliberately not using connect().
      const conn = createConnection({ providerId: 'groq' });

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.connectionId).toBe(conn.id);
      expect(res.candidates[0]?.excludedReason).toBe('No API key configured');
    });

    it('excludes a model whose modality does not match the request', () => {
      connect('openai');

      // An embeddings model requested on the chat pipeline.
      const res = expandCandidates(ex('openai/text-embedding-3-small', { modality: 'chat' }));

      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]?.excludedReason).toBe('Model does not serve chat');
    });

    it('excludes a connection whose circuit breaker is open', () => {
      const groq = connect('groq');
      upsertHealthRow({
        ...defaultHealthRow(groq),
        breaker: 'open',
        openedAt: Date.now(),
        cooldownUntil: Date.now() + 600_000,
        openCount: 1,
      });

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates[0]?.excludedReason).toBe('Circuit breaker open — provider is failing');
    });

    it('excludes a model that is under a 429 lockout', () => {
      const groq = connect('groq');
      setLockout(groq, 'llama-3.1-8b-instant', Date.now() + 600_000, 'rate limited');

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates[0]?.excludedReason).toBe('Model rate-limited (429 lockout active)');
    });

    it('does not exclude a model whose lockout has already expired', () => {
      const groq = connect('groq');
      // setLockout ignores a past `until`, so plant one just past now and let it lapse.
      setLockout(groq, 'llama-3.1-8b-instant', Date.now() - 1, 'stale');

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant'));

      expect(res.candidates[0]?.excludedReason).toBeNull();
    });

    it('excludes a model missing a required chat feature and names the feature', () => {
      connect('groq');

      // Llama 3.1 8B Instant supports tools/json_mode but not vision.
      const res = expandCandidates(
        ex('groq/llama-3.1-8b-instant', { requiredFeatures: ['vision'] as ChatFeature[] }),
      );

      expect(res.candidates[0]?.excludedReason).toBe('Model lacks required feature: vision');
    });

    it('keeps a model that does support the required feature', () => {
      connect('groq');

      // Llama 4 Scout carries the vision feature.
      const res = expandCandidates(
        ex('groq/meta-llama/llama-4-scout-17b-16e-instruct', { requiredFeatures: ['vision'] }),
      );

      expect(res.candidates[0]?.excludedReason).toBeNull();
    });

    it('excludes a model whose context window cannot hold the request, quoting the numbers', () => {
      connect('groq');

      const res = expandCandidates(
        ex('groq/llama-3.1-8b-instant', { inputTokens: 1_000_000, maxOutput: 1_024 }),
      );

      const reason = res.candidates[0]?.excludedReason ?? '';
      expect(reason).toContain('Context too small');
      // ~ needed tokens = inputTokens + maxOutput, window = model.contextWindow.
      expect(reason).toContain('1001024');
      expect(reason).toContain('131072');
    });

    it('excludes a candidate over the combo\'s cost ceiling, quoting the price and ceiling', () => {
      const openai = connect('openai');
      createCombo({
        slug: 'capped',
        name: 'Capped',
        maxCostPerMTok: 1,
        members: [{ connectionId: openai, modelId: 'gpt-4o', order: 0, weight: 1, enabled: true }],
      });

      const res = expandCandidates(ex('capped'));

      const gpt4o = findModel('openai', 'gpt-4o');
      expect(gpt4o).not.toBeNull();
      const reason = res.candidates[0]?.excludedReason ?? '';
      // Blended price of gpt-4o is $4.375/MTok, printed to two decimals.
      expect(reason).toBe(`Costs $${blendedPrice(gpt4o!).toFixed(2)}/MTok, over the $1/MTok ceiling`);
      expect(reason).toContain('4.38');
      expect(reason).toContain('over the $1/MTok ceiling');
    });

    it('treats a $0 combo ceiling as "free tiers only", not "nothing at all"', () => {
      // The ceiling is compared to the effective price, which is 0 for a free tier,
      // so a free candidate survives a $0 cap while a paid one does not.
      const groq = connect('groq');
      const openai = connect('openai');
      createCombo({
        slug: 'zero-cap',
        name: 'Zero cap',
        maxCostPerMTok: 0,
        members: [
          { connectionId: groq, modelId: 'llama-3.1-8b-instant', order: 0, weight: 1, enabled: true },
          { connectionId: openai, modelId: 'gpt-4o', order: 1, weight: 1, enabled: true },
        ],
      });

      const res = expandCandidates(ex('zero-cap'));

      const free = res.candidates.find((c) => c.connectionId === groq);
      const paid = res.candidates.find((c) => c.connectionId === openai);
      expect(free?.excludedReason).toBeNull();
      expect(paid?.excludedReason).toBe('Costs $4.38/MTok, over the $0/MTok ceiling');
    });

    it('excludes a paid candidate under freeOnly and names the budget cause', () => {
      connect('openai');

      const res = expandCandidates(ex('openai/gpt-4o', { freeOnly: true }));

      expect(res.candidates[0]?.tier).not.toBe('free');
      expect(res.candidates[0]?.excludedReason).toBe(
        'API key is over budget — restricted to free providers',
      );
    });

    it('keeps a free candidate under freeOnly', () => {
      connect('groq');

      const res = expandCandidates(ex('groq/llama-3.1-8b-instant', { freeOnly: true }));

      expect(res.candidates[0]?.tier).toBe('free');
      expect(res.candidates[0]?.excludedReason).toBeNull();
    });

    it('excludes a connection whose monthly budget is exhausted, quoting spend and budget', () => {
      const openai = createConnection({ providerId: 'openai', monthlyBudgetUsd: 5 });
      setCredential(openai.id, 'sk-openai');
      recordUsageBucket({
        ts: Date.now(),
        connectionId: openai.id,
        modelId: 'gpt-4o',
        ok: true,
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 10,
        savedUsd: 0,
      });

      const res = expandCandidates(ex('openai/gpt-4o'));

      expect(res.candidates[0]?.excludedReason).toBe(
        'Monthly budget exhausted ($10.00 of $5.00)',
      );
    });

    it('keeps a connection whose spend is still under its monthly budget', () => {
      const openai = createConnection({ providerId: 'openai', monthlyBudgetUsd: 100 });
      setCredential(openai.id, 'sk-openai');
      recordUsageBucket({
        ts: Date.now(),
        connectionId: openai.id,
        modelId: 'gpt-4o',
        ok: true,
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 10,
        savedUsd: 0,
      });

      const res = expandCandidates(ex('openai/gpt-4o'));

      expect(res.candidates[0]?.excludedReason).toBeNull();
    });

    it('excludes exactly at the budget boundary (spent === budget)', () => {
      // The guard is `spent >= budget`, so hitting the ceiling exactly excludes.
      const openai = createConnection({ providerId: 'openai', monthlyBudgetUsd: 10 });
      setCredential(openai.id, 'sk-openai');
      recordUsageBucket({
        ts: Date.now(),
        connectionId: openai.id,
        modelId: 'gpt-4o',
        ok: true,
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 10,
        savedUsd: 0,
      });

      const res = expandCandidates(ex('openai/gpt-4o'));

      expect(res.candidates[0]?.excludedReason).toBe(
        'Monthly budget exhausted ($10.00 of $10.00)',
      );
    });
  });

  describe('memberOrderMap', () => {
    it('is empty for a null combo', () => {
      expect(memberOrderMap(null).size).toBe(0);
    });

    it('keys each member by connectionId:modelId with its declared order', () => {
      const a = connect('groq');
      const b = connect('openai');
      const combo = createCombo({
        slug: 'ordered',
        name: 'Ordered',
        members: [
          { connectionId: a, modelId: 'llama-3.1-8b-instant', order: 3, weight: 1, enabled: true },
          { connectionId: b, modelId: '*', order: 7, weight: 1, enabled: true },
        ],
      });

      const map = memberOrderMap(combo);

      expect(map.get(`${a}:llama-3.1-8b-instant`)).toBe(3);
      expect(map.get(`${b}:*`)).toBe(7);
    });
  });
});

// ─── estimate.ts ─────────────────────────────────────────────────────────────

describe('router/estimate', () => {
  describe('fitsContext', () => {
    it('rejects a request that only just fits without the 5% headroom', () => {
      // input + output == window exactly, but 1.05x input tips it over.
      const m = model({ contextWindow: 1_000, maxOutput: 1_000 });
      expect(200 + 800).toBe(m.contextWindow); // fits with no headroom
      expect(fitsContext(m, 200, 800)).toBe(false);
    });

    it('accepts a request that fits once the headroom is applied', () => {
      const m = model({ contextWindow: 1_000, maxOutput: 1_000 });
      // 190 * 1.05 + 800 = 999.5 <= 1000
      expect(fitsContext(m, 190, 800)).toBe(true);
    });

    it('measures against the clamped output, not the requested output', () => {
      const m = model({ contextWindow: 1_000, maxOutput: 100 });
      // Requested 5000 output clamps to 100, so 800*1.05 + 100 = 940 <= 1000.
      expect(fitsContext(m, 800, 5_000)).toBe(true);
    });

    it('rejects when even the clamped output overflows the window', () => {
      const m = model({ contextWindow: 1_000, maxOutput: 100 });
      expect(fitsContext(m, 1_000, 5_000)).toBe(false);
    });
  });

  describe('projectCost', () => {
    it('clamps the requested output down to the model maxOutput', () => {
      const m = model({ inputCostPerMTok: 1_000, outputCostPerMTok: 1_000, maxOutput: 2_000 });
      // output clamps 10_000 -> 2_000: (1000*1000 + 2000*1000) / 1e6 = 3.
      expect(projectCost(m, 1_000, 10_000)).toBe(3);
    });

    it('uses the requested output when it is below the model maxOutput', () => {
      const m = model({ inputCostPerMTok: 1_000, outputCostPerMTok: 1_000, maxOutput: 2_000 });
      // (1000*1000 + 1000*1000) / 1e6 = 2.
      expect(projectCost(m, 1_000, 1_000)).toBe(2);
    });

    it('is zero for a free model regardless of token counts', () => {
      const m = model({ inputCostPerMTok: 0, outputCostPerMTok: 0, maxOutput: 8_192 });
      expect(projectCost(m, 100_000, 8_192)).toBe(0);
    });
  });

  describe('blendedPrice', () => {
    it('weights input and output 3:1', () => {
      // 4 * 0.75 + 8 * 0.25 = 5.
      expect(blendedPrice(model({ inputCostPerMTok: 4, outputCostPerMTok: 8 }))).toBe(5);
    });
  });

  describe('requestedMaxOutput', () => {
    it('reads max_tokens', () => {
      expect(requestedMaxOutput({ max_tokens: 500 })).toBe(500);
    });

    it('reads max_completion_tokens when max_tokens is absent', () => {
      expect(requestedMaxOutput({ max_completion_tokens: 700 })).toBe(700);
    });

    it('reads max_output_tokens when the others are absent', () => {
      expect(requestedMaxOutput({ max_output_tokens: 900 })).toBe(900);
    });

    it('prefers max_tokens over the alternative keys', () => {
      expect(
        requestedMaxOutput({ max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3 }),
      ).toBe(1);
    });

    it('falls back to 1024 when no output key is present', () => {
      expect(requestedMaxOutput({})).toBe(1_024);
    });

    it('falls back to 1024 for a zero or negative value', () => {
      expect(requestedMaxOutput({ max_tokens: 0 })).toBe(1_024);
      expect(requestedMaxOutput({ max_tokens: -5 })).toBe(1_024);
    });

    it('falls back to 1024 for a non-finite or non-numeric value', () => {
      expect(requestedMaxOutput({ max_tokens: Number.NaN })).toBe(1_024);
      expect(requestedMaxOutput({ max_tokens: Number.POSITIVE_INFINITY })).toBe(1_024);
      expect(requestedMaxOutput({ max_tokens: '2048' })).toBe(1_024);
    });
  });
});
