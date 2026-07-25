import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { open, seal, ensureMasterKey, masterKeyPath, reloadMasterKey } from '@/lib/crypto/vault';
import { dropDb, freshDb } from '../helpers/db';

describe('crypto/vault', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
    delete process.env.SWITCHBOARD_MASTER_KEY;
    reloadMasterKey();
  });

  afterEach(() => {
    delete process.env.SWITCHBOARD_MASTER_KEY;
    dropDb(dir);
  });

  describe('round trip', () => {
    it('returns exactly what was sealed', () => {
      const secret = 'gsk_live_abcdefghijklmnopqrstuvwxyz0123456789';
      const { ciphertext, iv, authTag } = seal(secret);
      expect(open(ciphertext, iv, authTag)).toBe(secret);
    });

    it('never stores the plaintext in the ciphertext', () => {
      const secret = 'sk-proj-VERYSECRETVALUE';
      const { ciphertext } = seal(secret);
      expect(ciphertext.toString('utf8')).not.toContain('VERYSECRET');
      expect(ciphertext.toString('latin1')).not.toContain(secret);
    });

    it('survives unicode and long values', () => {
      const secret = `${'ключ-🔑-'.repeat(200)}end`;
      const { ciphertext, iv, authTag } = seal(secret);
      expect(open(ciphertext, iv, authTag)).toBe(secret);
    });

    it('handles the empty string rather than throwing', () => {
      const { ciphertext, iv, authTag } = seal('');
      expect(open(ciphertext, iv, authTag)).toBe('');
    });

    it('produces a different ciphertext each time for the same input', () => {
      // A fresh IV per seal is what stops two identical keys from being
      // recognisable as identical in the database.
      const a = seal('same-value');
      const b = seal('same-value');
      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
      expect(open(a.ciphertext, a.iv, a.authTag)).toBe('same-value');
      expect(open(b.ciphertext, b.iv, b.authTag)).toBe('same-value');
    });

    it('uses a 12-byte IV and a 16-byte auth tag', () => {
      const { iv, authTag } = seal('x');
      expect(iv).toHaveLength(12);
      expect(authTag).toHaveLength(16);
    });
  });

  describe('tamper detection', () => {
    it('throws when the ciphertext is altered', () => {
      const { ciphertext, iv, authTag } = seal('original-secret');
      const tampered = Buffer.from(ciphertext);
      tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
      expect(() => open(tampered, iv, authTag)).toThrow(/could not decrypt/i);
    });

    it('throws when the auth tag is altered', () => {
      const { ciphertext, iv, authTag } = seal('original-secret');
      const tampered = Buffer.from(authTag);
      tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
      expect(() => open(ciphertext, iv, tampered)).toThrow(/could not decrypt/i);
    });

    it('throws when the IV is altered', () => {
      const { ciphertext, iv, authTag } = seal('original-secret');
      const tampered = Buffer.from(iv);
      tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
      expect(() => open(ciphertext, tampered, authTag)).toThrow(/could not decrypt/i);
    });

    it('rejects a wrong-length IV with a specific message', () => {
      const { ciphertext, authTag } = seal('x');
      expect(() => open(ciphertext, Buffer.alloc(8), authTag)).toThrow(/8-byte IV/);
    });

    it('rejects a wrong-length auth tag with a specific message', () => {
      const { ciphertext, iv } = seal('x');
      expect(() => open(ciphertext, iv, Buffer.alloc(4))).toThrow(/4-byte auth tag/);
    });

    it('never leaks the payload in the failure message', () => {
      const { ciphertext, iv, authTag } = seal('sk-SUPERSECRET-payload');
      const tampered = Buffer.from(authTag);
      tampered[15] = (tampered[15]! ^ 0xff) & 0xff;
      try {
        open(ciphertext, iv, tampered);
        expect.unreachable('open should have thrown');
      } catch (err) {
        expect(String(err)).not.toContain('SUPERSECRET');
      }
    });
  });

  describe('master key lifecycle', () => {
    it('generates a 32-byte key on first use and persists it', () => {
      const key = ensureMasterKey();
      expect(key).toHaveLength(32);
      expect(readFileSync(masterKeyPath())).toHaveLength(32);
    });

    it('reuses the key on subsequent calls rather than regenerating', () => {
      const first = ensureMasterKey();
      const second = ensureMasterKey();
      expect(first.equals(second)).toBe(true);
    });

    it('adopts an existing key file instead of overwriting it', () => {
      // The dangerous failure is a second process clobbering a key that has
      // already sealed rows, making every stored credential unreadable.
      const planted = randomBytes(32);
      ensureMasterKey();
      writeFileSync(masterKeyPath(), planted);
      const adopted = reloadMasterKey();
      expect(adopted.equals(planted)).toBe(true);
    });

    it('refuses a key file of the wrong length', () => {
      ensureMasterKey();
      writeFileSync(masterKeyPath(), randomBytes(16));
      expect(() => reloadMasterKey()).toThrow(/16 bytes; expected 32/);
    });

    it('accepts a base64 key from the environment', () => {
      const injected = randomBytes(32);
      process.env.SWITCHBOARD_MASTER_KEY = injected.toString('base64');
      expect(reloadMasterKey().equals(injected)).toBe(true);
    });

    it('rejects an environment key of the wrong length with actionable text', () => {
      process.env.SWITCHBOARD_MASTER_KEY = randomBytes(20).toString('base64');
      expect(() => reloadMasterKey()).toThrow(/must be 32 bytes of base64/);
    });

    it('prefers the environment key over the file on disk', () => {
      ensureMasterKey();
      const onDisk = readFileSync(masterKeyPath());
      const injected = randomBytes(32);
      process.env.SWITCHBOARD_MASTER_KEY = injected.toString('base64');
      const active = reloadMasterKey();
      expect(active.equals(injected)).toBe(true);
      expect(active.equals(onDisk)).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('writes the key file 0600', () => {
      ensureMasterKey();
      // Windows has no POSIX mode bits, so this only means anything elsewhere.
      expect(statSync(masterKeyPath()).mode & 0o777).toBe(0o600);
    });
  });

  describe('key rotation', () => {
    it('cannot open values sealed under a previous key', () => {
      // This is the whole reason `open` throws loudly: a rotated key must
      // surface as an obvious error, not as a mysterious upstream 401 later.
      const sealed = seal('credential-under-old-key');

      process.env.SWITCHBOARD_MASTER_KEY = randomBytes(32).toString('base64');
      reloadMasterKey();

      expect(() => open(sealed.ciphertext, sealed.iv, sealed.authTag)).toThrow(
        /master key|rotated/i,
      );
    });

    it('reads old values again once the original key is restored', () => {
      const original = ensureMasterKey().toString('base64');
      const sealed = seal('recoverable-secret');

      process.env.SWITCHBOARD_MASTER_KEY = randomBytes(32).toString('base64');
      reloadMasterKey();
      expect(() => open(sealed.ciphertext, sealed.iv, sealed.authTag)).toThrow();

      process.env.SWITCHBOARD_MASTER_KEY = original;
      reloadMasterKey();
      expect(open(sealed.ciphertext, sealed.iv, sealed.authTag)).toBe('recoverable-secret');
    });
  });
});
