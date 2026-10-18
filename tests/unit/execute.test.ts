import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandCandidates, scoreCandidates } from '@/lib/router';
import { executeRoute } from '@/lib/router/execute';
import { createConnection } from '@/lib/db/repos/connections';
import { setCredential } from '@/lib/db/repos/credentials';
import { getHealthRow, upsertHealthRow } from '@/lib/db/repos/health';
import { statusForErrorKind } from '@/lib/api/respond';
import { reloadMasterKey } from '@/lib/crypto/vault';
import { dropDb, freshDb } from '../helpers/db';

const ex = (requestedModel = 'auto') => ({
  modality: 'chat' as const,
  requestedModel,
  inputTokens: 100,
  maxOutput: 100,
  requiredFeatures: [],
  freeOnly: false,
  apiKey: null,
});

function connect(providerId: string): string {
  const c = createConnection({ providerId });
  setCredential(c.id, `sk-test-${c.id}`);
  return c.id;
}

function ranked(requestedModel = 'auto') {
  const expanded = expandCandidates(ex(requestedModel));
  return scoreCandidates(expanded.candidates, 'free-first', { strategy: 'free-first', combo: null, rotation: 0 });
}

function run(candidates: ReturnType<typeof ranked>, signal = new AbortController().signal) {
  return executeRoute({
    candidates,
    modality: 'chat',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    stream: false,
    signal,
    maxAttempts: 4,
    timeoutMs: 10_000,
  });
}

const okBody = () =>
  new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Puts a connection's breaker open with its cooldown already over. */
function lapsedOpen(id: string): void {
  upsertHealthRow({ ...getHealthRow(id), breaker: 'open', cooldownUntil: Date.now() - 1, openCount: 1 });
}

describe('router/executeRoute', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
    reloadMasterKey();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dropDb(dir);
  });

  describe('client disconnect', () => {
    it('stops the walk instead of buying answers for nobody, and blames no provider', async () => {
      const ids = [connect('groq'), connect('cerebras'), connect('mistral')];
      const client = new AbortController();
      let calls = 0;

      // An upstream that answers after 30ms unless aborted; the client leaves
      // 5ms into the first attempt.
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) setTimeout(() => client.abort(), 5);
        return new Promise((resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => resolve(okBody()), 30);
        });
      });

      const out = await run(ranked(), client.signal);

      expect(calls).toBe(1);
      expect(out.winningAttempt).toBeNull();
      expect(out.attempts).toHaveLength(1);
      expect(out.attempts[0]?.fallbackReason).toBe('Client disconnected');
      expect(ids.map((id) => getHealthRow(id).failureCount)).toEqual([0, 0, 0]);
    });

    it('does not start at all when the client is already gone', async () => {
      connect('groq');
      const client = new AbortController();
      client.abort();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const out = await run(ranked(), client.signal);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out.attempts).toHaveLength(0);
    });
  });

  describe('half-open trial slot', () => {
    it('is not consumed by expansion alone (the routing simulator, unattempted candidates)', () => {
      const id = connect('groq');
      lapsedOpen(id);

      const first = expandCandidates(ex()).candidates.find((c) => c.connectionId === id);
      const second = expandCandidates(ex()).candidates.find((c) => c.connectionId === id);

      expect(getHealthRow(id).breaker).toBe('open');
      expect(first?.excludedReason).toBeNull();
      expect(second?.excludedReason).toBeNull();
    });

    it('is claimed by the request that is actually sent', async () => {
      const id = connect('groq');
      lapsedOpen(id);
      vi.stubGlobal('fetch', () => Promise.resolve(okBody()));

      const out = await run(ranked('groq/llama-3.1-8b-instant'));

      expect(out.winningAttempt).toBe(0);
      expect(getHealthRow(id).breaker).toBe('closed');
    });

    it('skips a connection whose trial another request took after expansion', async () => {
      const id = connect('groq');
      lapsedOpen(id);
      const candidates = ranked('groq/llama-3.1-8b-instant');
      // Another request is sent in between and takes the trial.
      upsertHealthRow({ ...getHealthRow(id), breaker: 'half-open', cooldownUntil: Date.now() + 60_000 });
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const out = await run(candidates);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out.error?.kind).toBe('unavailable');
    });
  });

  describe('everything temporarily out', () => {
    it('answers 503, not 404, when every candidate is behind an open breaker', async () => {
      const id = connect('groq');
      upsertHealthRow({ ...getHealthRow(id), breaker: 'open', cooldownUntil: Date.now() + 60_000, openCount: 1 });

      const out = await run(ranked());

      expect(out.error?.kind).toBe('unavailable');
      expect(statusForErrorKind(out.error!.kind)).toBe(503);
    });

    it('still answers 404 when nothing could ever serve the request', async () => {
      const out = await run(ranked());
      expect(out.error?.kind).toBe('unsupported');
      expect(statusForErrorKind('unsupported')).toBe(404);
    });
  });
});
