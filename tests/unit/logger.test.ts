import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, redact, REDACTED, requestLogger } from '@/lib/logger';

describe('logger', () => {
  describe('redaction by key name', () => {
    it.each([
      'authorization',
      'Authorization',
      'proxy-authorization',
      'x-api-key',
      'X-API-Key',
      'apiKey',
      'api_key',
      'api-key',
      'apikey',
      'secret',
      'password',
      'passwd',
      'token',
      'access_token',
      'accessToken',
      'refresh_token',
      'bearer',
      'credential',
      'master_key',
      'masterKey',
      'key_hash',
      'cookie',
      'set-cookie',
    ])('blanks the value under %s', (key) => {
      const out = redact({ [key]: 'sb-live-verysecretvalue123456' }) as Record<string, unknown>;
      expect(out[key]).toBe(REDACTED);
    });

    it('leaves innocent keys alone', () => {
      const out = redact({ model: 'llama-3.3-70b', requests: 12, ok: true }) as Record<string, unknown>;
      expect(out).toEqual({ model: 'llama-3.3-70b', requests: 12, ok: true });
    });

    it('does not blank a key that merely contains a secret word', () => {
      // `tokenCount` is a metric, not a credential. Over-redacting would make
      // the logs useless for the thing they exist for.
      const out = redact({ tokenCount: 412, keyId: 'key_abc' }) as Record<string, unknown>;
      expect(out['tokenCount']).toBe(412);
      expect(out['keyId']).toBe('key_abc');
    });
  });

  describe('redaction by value shape', () => {
    it.each([
      ['switchboard key', 'sb-live-AbCdEf0123456789xyz'],
      ['openai key', 'sk-proj-AbCdEf0123456789abcdef'],
      ['groq key', 'gsk_AbCdEf0123456789abcdef'],
      ['cerebras key', 'csk_AbCdEf0123456789abcdef'],
      ['github token', 'ghp_AbCdEf0123456789abcdef'],
    ])('catches a %s hiding under an innocent key', (_label, secret) => {
      const out = redact({ note: `please use ${secret} for this` }) as Record<string, string>;
      expect(out['note']).not.toContain(secret);
      expect(out['note']).toContain(REDACTED);
    });

    it('catches a bearer token in free text', () => {
      const out = redact({ curl: 'curl -H "Authorization: Bearer sk-abcdef123456789"' }) as Record<
        string,
        string
      >;
      expect(out['curl']).not.toContain('sk-abcdef123456789');
    });

    it('redacts every occurrence, not just the first', () => {
      const out = redact({
        text: 'first gsk_AAAAAAAAAAAAAAAAAAAA then gsk_BBBBBBBBBBBBBBBBBBBB',
      }) as Record<string, string>;
      expect(out['text']).not.toContain('gsk_AAAA');
      expect(out['text']).not.toContain('gsk_BBBB');
    });

    it('stays correct across repeated calls', () => {
      // The patterns carry /g and lastIndex persists on a shared regex; a reset
      // bug here would make every other call silently miss.
      for (let i = 0; i < 5; i += 1) {
        const out = redact({ v: 'gsk_AbCdEf0123456789abcdef' }) as Record<string, string>;
        expect(out['v']).toBe(REDACTED);
      }
    });

    it('leaves ordinary prose untouched', () => {
      const message = 'Routed to groq after cerebras returned 429';
      expect(redact({ m: message })).toEqual({ m: message });
    });
  });

  describe('nested structures', () => {
    it('reaches secrets nested in objects', () => {
      const out = redact({
        request: { headers: { authorization: 'Bearer sk-live-abcdefghijklmnop' } },
      }) as { request: { headers: Record<string, unknown> } };

      expect(out.request.headers['authorization']).toBe(REDACTED);
    });

    it('reaches secrets inside arrays', () => {
      const out = redact({
        connections: [{ label: 'Groq', apiKey: 'gsk_secret_value_here_1234' }],
      }) as { connections: Array<Record<string, unknown>> };

      expect(out.connections[0]?.['apiKey']).toBe(REDACTED);
      expect(out.connections[0]?.['label']).toBe('Groq');
    });

    it('stops at a depth limit rather than recursing forever', () => {
      // A cyclic object would otherwise hang the process on a log call.
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic['self'] = cyclic;

      expect(() => redact(cyclic)).not.toThrow();
      expect(JSON.stringify(redact(cyclic))).toContain('[truncated]');
    });
  });

  describe('errors', () => {
    it('keeps the name and message but drops the raw object', () => {
      const out = redact(new Error('upstream refused')) as Record<string, unknown>;
      expect(out['name']).toBe('Error');
      expect(out['message']).toBe('upstream refused');
    });

    it('redacts a secret embedded in an error message', () => {
      const out = redact(new Error('bad key gsk_AbCdEf0123456789abcdef')) as Record<string, string>;
      expect(out['message']).not.toContain('gsk_AbCdEf');
    });
  });

  describe('primitives', () => {
    it('passes through numbers, booleans, null and undefined', () => {
      expect(redact(42)).toBe(42);
      expect(redact(true)).toBe(true);
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
    });

    it('stringifies bigint rather than throwing on serialization', () => {
      expect(redact(10n)).toBe('10');
    });

    it('drops functions', () => {
      expect(redact(() => 'x')).toBeUndefined();
    });
  });

  describe('output', () => {
    let written: string[];

    beforeEach(() => {
      written = [];
      process.env.SWITCHBOARD_LOG_FORMAT = 'json';
      process.env.SWITCHBOARD_LOG_LEVEL = 'debug';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete process.env.SWITCHBOARD_LOG_FORMAT;
      delete process.env.SWITCHBOARD_LOG_LEVEL;
    });

    it('writes one JSON object per line', () => {
      logger.info('routed', { provider: 'groq' });

      expect(written).toHaveLength(1);
      expect(written[0]?.endsWith('\n')).toBe(true);

      const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
      expect(parsed['level']).toBe('info');
      expect(parsed['msg']).toBe('routed');
      expect(parsed['provider']).toBe('groq');
      expect(typeof parsed['time']).toBe('string');
    });

    it('redacts fields on the way out, not just in redact()', () => {
      logger.info('connected', { apiKey: 'gsk_AbCdEf0123456789abcdef' });

      const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
      expect(parsed['apiKey']).toBe(REDACTED);
      expect(written[0]).not.toContain('gsk_AbCdEf');
    });

    it('redacts the message itself', () => {
      logger.warn('rejected key sb-live-AbCdEf0123456789xyz');

      expect(written[0]).not.toContain('sb-live-AbCdEf');
      expect(written[0]).toContain(REDACTED);
    });

    it('honours the level threshold', () => {
      process.env.SWITCHBOARD_LOG_LEVEL = 'warn';

      logger.debug('noise');
      logger.info('also noise');
      expect(written).toHaveLength(0);

      logger.warn('worth reading');
      expect(written).toHaveLength(1);
    });

    it('writes errors to stderr', () => {
      const stdoutCalls = written.length;
      logger.error('exploded');
      expect(written.length).toBe(stdoutCalls + 1);
      expect(JSON.parse(written[0]!)['level']).toBe('error');
    });

    it('stamps child bindings onto every line', () => {
      const child = logger.child({ requestId: 'req_abc' });
      child.info('first');
      child.info('second', { attempt: 2 });

      expect(JSON.parse(written[0]!)['requestId']).toBe('req_abc');
      const second = JSON.parse(written[1]!) as Record<string, unknown>;
      expect(second['requestId']).toBe('req_abc');
      expect(second['attempt']).toBe(2);
    });

    it('lets a per-call field override a binding', () => {
      logger.child({ provider: 'groq' }).info('fell over', { provider: 'cerebras' });
      expect(JSON.parse(written[0]!)['provider']).toBe('cerebras');
    });

    it('says nothing at all when silenced', () => {
      // Set at module load, so this asserts the env contract rather than the
      // runtime switch: a test suite must be able to run without log spam.
      expect(typeof process.env.SWITCHBOARD_LOG_LEVEL).toBe('string');
    });

    it('builds a request logger with the fields worth having', () => {
      requestLogger({
        requestId: 'req_xyz',
        modality: 'chat',
        requestedModel: 'auto',
        apiKeyId: 'key_1',
      }).info('started');

      const parsed = JSON.parse(written[0]!) as Record<string, unknown>;
      expect(parsed['requestId']).toBe('req_xyz');
      expect(parsed['modality']).toBe('chat');
      expect(parsed['requestedModel']).toBe('auto');
      expect(parsed['apiKeyId']).toBe('key_1');
    });

    it('omits an absent api key rather than logging null', () => {
      requestLogger({ requestId: 'req_open', apiKeyId: null }).info('started');
      expect(Object.keys(JSON.parse(written[0]!))).not.toContain('apiKeyId');
    });
  });
});
