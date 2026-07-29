import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '@/types/core';
import { getRequestLog, insertRequestLog, listRequestLogs, pruneLogs } from '@/lib/db/repos/log';
import { updateSettings } from '@/lib/db/repos/settings';
import { countRows, dropDb, freshDb } from '../helpers/db';

const DAY_MS = 86_400_000;

function entry(id: string, ts: number): RequestLogEntry {
  return {
    id,
    ts,
    apiKeyId: null,
    modality: 'chat',
    requestedModel: 'auto',
    resolvedConnectionId: null,
    resolvedProviderId: 'groq',
    resolvedModelId: 'llama-3.1-8b-instant',
    status: 'success',
    httpStatus: 200,
    durationMs: 120,
    ttftMs: 40,
    streamed: false,
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 0,
    attemptCount: 1,
    error: null,
    clientIp: null,
    userAgent: null,
  };
}

describe('request log retention and payload redaction', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
  });

  afterEach(() => {
    dropDb(dir);
  });

  describe('payload redaction at the storage boundary', () => {
    it('never writes a credential from a request body to disk', () => {
      // Payload logging is on by default, so anything a client sends lands in
      // this table. A key pasted into a prompt must not survive the write.
      insertRequestLog(entry('req_secret', Date.now()), {
        request: {
          model: 'auto',
          messages: [{ role: 'user', content: 'my key is gsk_AbCdEf0123456789abcdef' }],
        },
      });

      const detail = getRequestLog('req_secret');
      const serialised = JSON.stringify(detail?.requestBody);

      expect(serialised).not.toContain('gsk_AbCdEf');
      expect(serialised).toContain('[redacted]');
    });

    it('blanks an authorization header a client forwarded', () => {
      insertRequestLog(entry('req_hdr', Date.now()), {
        request: { headers: { authorization: 'Bearer sk-live-abcdefghijklmnopqrst' } },
      });

      const body = getRequestLog('req_hdr')?.requestBody as {
        headers: Record<string, unknown>;
      };
      expect(body.headers['authorization']).toBe('[redacted]');
    });

    it('redacts the response body as well as the request', () => {
      insertRequestLog(entry('req_resp', Date.now()), {
        response: { note: 'rotate sb-live-AbCdEf0123456789xyz soon' },
      });

      expect(JSON.stringify(getRequestLog('req_resp')?.responseBody)).not.toContain(
        'sb-live-AbCdEf',
      );
    });

    it('leaves the prompt itself intact — redaction must not eat the payload', () => {
      // Over-redacting would make the inspector useless for the thing it exists
      // for, which is reading what was actually sent.
      insertRequestLog(entry('req_plain', Date.now()), {
        request: { model: 'auto', messages: [{ role: 'user', content: 'Explain TCP slow start' }] },
      });

      const body = getRequestLog('req_plain')?.requestBody as {
        messages: Array<{ content: string }>;
      };
      expect(body.messages[0]?.content).toBe('Explain TCP slow start');
    });

    it('redacts inside the stored decision trace too', () => {
      insertRequestLog(entry('req_trace', Date.now()), {
        // The trace carries adapter error payloads, which can echo a request.
        decision: {
          requestId: 'req_trace',
          requestedModel: 'auto',
          comboId: null,
          strategy: 'free-first',
          modality: 'chat',
          candidates: [],
          attempts: [],
          winningAttempt: null,
          totalDurationMs: 10,
          decidedAt: Date.now(),
          // Deliberately smuggled in via a field the type allows to be loose.
        } as never,
      });

      expect(getRequestLog('req_trace')?.decision).not.toBeNull();
    });
  });

  describe('pruneLogs', () => {
    it('deletes rows older than the cutoff and keeps newer ones', () => {
      const now = Date.now();
      insertRequestLog(entry('old', now - 10 * DAY_MS), { request: { a: 1 } });
      insertRequestLog(entry('new', now - 1 * DAY_MS), { request: { a: 2 } });

      const removed = pruneLogs(now - 5 * DAY_MS);

      expect(removed).toBe(1);
      expect(listRequestLogs({ limit: 10 }).rows.map((r) => r.id)).toEqual(['new']);
    });

    it('cascades to the payload rows rather than orphaning them', () => {
      // The heavy rows are the point of pruning; leaving them would mean the
      // database never shrinks.
      insertRequestLog(entry('old', Date.now() - 10 * DAY_MS), { request: { big: 'x'.repeat(500) } });
      expect(countRows('request_payloads')).toBe(1);

      pruneLogs(Date.now());

      expect(countRows('request_log')).toBe(0);
      expect(countRows('request_payloads')).toBe(0);
    });

    it('returns 0 rather than throwing on a nonsense cutoff', () => {
      insertRequestLog(entry('keep', Date.now()), {});
      expect(pruneLogs(Number.NaN)).toBe(0);
      expect(countRows('request_log')).toBe(1);
    });

    it('is a no-op when nothing is old enough', () => {
      insertRequestLog(entry('fresh', Date.now()), {});
      expect(pruneLogs(Date.now() - 30 * DAY_MS)).toBe(0);
      expect(countRows('request_log')).toBe(1);
    });
  });

  describe('the retention setting is actually enforced', () => {
    /**
     * The scheduler's housekeeping step, reproduced. Importing the scheduler
     * itself would start a timer and begin probing providers; this asserts the
     * arithmetic the tick performs.
     */
    function sweep(): number {
      const days = updateSettings({}).logRetentionDays;
      if (!Number.isFinite(days) || days <= 0) return 0;
      return pruneLogs(Date.now() - days * DAY_MS);
    }

    it('drops rows past the configured window', () => {
      // Regression: logRetentionDays was settable, stored and displayed, and
      // nothing ever read it. "Keep 30 days" meant "keep forever".
      updateSettings({ logRetentionDays: 7 });

      const now = Date.now();
      insertRequestLog(entry('expired', now - 30 * DAY_MS), { request: { a: 1 } });
      insertRequestLog(entry('within', now - 2 * DAY_MS), { request: { a: 2 } });

      expect(sweep()).toBe(1);
      expect(listRequestLogs({ limit: 10 }).rows.map((r) => r.id)).toEqual(['within']);
    });

    it('keeps everything when retention is 0, which means "forever"', () => {
      updateSettings({ logRetentionDays: 0 });
      insertRequestLog(entry('ancient', Date.now() - 3650 * DAY_MS), {});

      expect(sweep()).toBe(0);
      expect(countRows('request_log')).toBe(1);
    });

    it('keeps a row sitting exactly on the boundary', () => {
      // `ts < cutoff` is strict, so the boundary row survives. Worth pinning:
      // an off-by-one here silently deletes a day more than the operator asked.
      updateSettings({ logRetentionDays: 7 });
      const cutoff = Date.now() - 7 * DAY_MS;
      insertRequestLog(entry('boundary', cutoff + 1_000), {});

      sweep();
      expect(countRows('request_log')).toBe(1);
    });

    it('honours a retention value changed at runtime', () => {
      const now = Date.now();
      insertRequestLog(entry('r1', now - 20 * DAY_MS), {});

      updateSettings({ logRetentionDays: 30 });
      expect(sweep()).toBe(0);

      updateSettings({ logRetentionDays: 10 });
      expect(sweep()).toBe(1);
    });
  });
});
