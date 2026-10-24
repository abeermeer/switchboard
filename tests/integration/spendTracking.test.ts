import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as chatPost } from '@/app/v1/chat/completions/route';
import { POST as replayPost } from '@/app/api/logs/[id]/replay/route';
import { POST as playgroundPost } from '@/app/api/playground/route';
import { DELETE as logsDelete } from '@/app/api/logs/route';
import { createConnection } from '@/lib/db/repos/connections';
import { setCredential } from '@/lib/db/repos/credentials';
import { createApiKey } from '@/lib/db/repos/apiKeys';
import { getRequestLog, insertRequestLog, listRequestLogs, pruneLogs } from '@/lib/db/repos/log';
import { monthToDateCostForApiKey, usageTotals } from '@/lib/db/repos/usage';
import { reloadMasterKey } from '@/lib/crypto/vault';
import { getDb } from '@/lib/db/client';
import { MIGRATIONS } from '@/lib/db/schema';
import { dropDb, freshDb } from '../helpers/db';
import { chatOk, jsonRequest, stubUpstream, type Upstream } from '../helpers/upstream';

const BASE = 'http://127.0.0.1:7272';

const TOOLS_BODY = {
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'weather?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'weather',
        parameters: { type: 'object', properties: { city: { type: 'string', description: 'City' } } },
      },
    },
  ],
};

function logEntry(id: string, apiKeyId: string | null, costUsd: number, ts = Date.now()) {
  return {
    id,
    ts,
    apiKeyId,
    modality: 'chat' as const,
    requestedModel: 'auto',
    resolvedConnectionId: null,
    resolvedProviderId: 'openai',
    resolvedModelId: 'gpt-4o-mini',
    status: 'success' as const,
    httpStatus: 200,
    durationMs: 10,
    ttftMs: null,
    streamed: false,
    usage: null,
    costUsd,
    attemptCount: 1,
    error: null,
    clientIp: null,
    userAgent: null,
  };
}

describe('spend tracking', () => {
  let dir: string;
  let upstream: Upstream | null = null;

  beforeEach(() => {
    dir = freshDb();
    reloadMasterKey();
    const groq = createConnection({ providerId: 'groq' });
    setCredential(groq.id, 'gsk_test_spend');
  });

  afterEach(() => {
    upstream?.restore();
    upstream = null;
    dropDb(dir);
  });

  describe('replay', () => {
    it('is logged and counted like any other billed request', async () => {
      upstream = stubUpstream([chatOk()]);
      await chatPost(jsonRequest(`${BASE}/v1/chat/completions`, TOOLS_BODY));
      const original = listRequestLogs({ limit: 10 }).rows[0]!;
      const before = usageTotals(0).requests;

      const res = await replayPost(new Request(`${BASE}/api/logs/${original.id}/replay`, { method: 'POST' }), {
        params: Promise.resolve({ id: original.id }),
      });

      expect(res.status).toBe(200);
      const rows = listRequestLogs({ limit: 10 }).rows;
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.userAgent === 'switchboard/replay')).toBe(true);
      expect(usageTotals(0).requests).toBe(before + 1);
    });

    it('sends the stored tool schema intact, not truncated by redaction', async () => {
      upstream = stubUpstream([chatOk()]);
      await chatPost(jsonRequest(`${BASE}/v1/chat/completions`, TOOLS_BODY));
      const original = listRequestLogs({ limit: 10 }).rows[0]!;

      // The stored copy was cut at depth 6, so leaf values read "[truncated]".
      expect(JSON.stringify(getRequestLog(original.id)?.requestBody)).not.toContain('[truncated]');

      await replayPost(new Request(`${BASE}/api/logs/${original.id}/replay`, { method: 'POST' }), {
        params: Promise.resolve({ id: original.id }),
      });
      const sent = upstream.calls[1]?.body as typeof TOOLS_BODY;
      expect(sent.tools[0]?.function.parameters.properties.city.type).toBe('string');
    });
  });

  describe('playground', () => {
    it('logs each model it runs and counts its usage', async () => {
      upstream = stubUpstream([
        {
          sse:
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n' +
            'data: [DONE]\n\n',
        },
      ]);

      const res = await playgroundPost(
        jsonRequest(`${BASE}/api/playground`, {
          models: ['llama-3.3-70b-versatile'],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      await res.text();

      const rows = listRequestLogs({ limit: 10 }).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userAgent).toBe('switchboard/playground');
      expect(rows[0]?.usage?.completionTokens).toBe(2);
      expect(usageTotals(0).requests).toBe(1);
    });
  });

  describe('playground reasoning', () => {
    it('prices reasoning that a provider reports beside completion', async () => {
      // xAI reports reasoning_tokens outside completion_tokens (the total shows
      // it). The playground used the older normalizer, which dropped them, so
      // a reasoning response was priced about 98% low.
      upstream = stubUpstream([
        {
          sse:
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":515,' +
            '"completion_tokens_details":{"reasoning_tokens":500}}}\n\n' +
            'data: [DONE]\n\n',
        },
      ]);

      const res = await playgroundPost(
        jsonRequest(`${BASE}/api/playground`, {
          models: ['llama-3.3-70b-versatile'],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      );
      await res.text();

      expect(listRequestLogs({ limit: 10 }).rows[0]?.usage?.completionTokens).toBe(505);
    });
  });

  describe('per-key budgets', () => {
    it('survive log retention pruning', () => {
      const { key } = createApiKey({ name: 'budgeted', monthlyBudgetUsd: 10 });
      insertRequestLog(logEntry('req_a', key.id, 1.5));
      expect(monthToDateCostForApiKey(key.id)).toBeCloseTo(1.5, 10);

      pruneLogs(Date.now() + 1);

      expect(listRequestLogs({ limit: 10 }).total).toBe(0);
      expect(monthToDateCostForApiKey(key.id)).toBeCloseTo(1.5, 10);
    });

    it('survive "clear logs" in the dashboard', async () => {
      const { key } = createApiKey({ name: 'budgeted', monthlyBudgetUsd: 10 });
      insertRequestLog(logEntry('req_b', key.id, 2, Date.now() - 1_000));

      await logsDelete(new Request(`${BASE}/api/logs`, { method: 'DELETE' }));

      expect(listRequestLogs({ limit: 10 }).total).toBe(0);
      expect(monthToDateCostForApiKey(key.id)).toBeCloseTo(2, 10);
    });

    it('do not count a rewritten log row twice', () => {
      const { key } = createApiKey({ name: 'budgeted', monthlyBudgetUsd: 10 });
      insertRequestLog(logEntry('req_c', key.id, 1));
      insertRequestLog(logEntry('req_c', key.id, 1.25));

      expect(monthToDateCostForApiKey(key.id)).toBeCloseTo(1.25, 10);
    });

    it('carry over what the log already holds when an existing install upgrades', () => {
      const { key } = createApiKey({ name: 'budgeted', monthlyBudgetUsd: 10 });
      insertRequestLog(logEntry('req_before_upgrade', key.id, 3));

      // Replay migration 3 as an install still on version 2 would run it.
      const migration = MIGRATIONS.find((m) => m.version === 3)!;
      getDb().exec('DROP TABLE api_key_spend');
      getDb().exec(migration.sql);

      expect(monthToDateCostForApiKey(key.id)).toBeCloseTo(3, 10);
    });

    it('start each UTC month at zero', () => {
      const { key } = createApiKey({ name: 'budgeted', monthlyBudgetUsd: 10 });
      const now = new Date();
      const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15);
      insertRequestLog(logEntry('req_old', key.id, 9, lastMonth));

      expect(monthToDateCostForApiKey(key.id)).toBe(0);
    });
  });
});
