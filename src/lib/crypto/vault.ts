import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '@/lib/db/client';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** Base64 override so container deployments can inject the key instead of mounting a file. */
const ENV_KEY = 'SWITCHBOARD_MASTER_KEY';

let cachedKey: Buffer | null = null;

export function masterKeyPath(): string {
  return join(dataDir(), 'master.key');
}

/**
 * The 32-byte key every sealed value in the database is bound to.
 *
 * Cached in module scope because it is read on every upstream request and the
 * file cannot change under a running process without invalidating the whole
 * credentials table anyway.
 */
export function ensureMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const injected = process.env[ENV_KEY]?.trim();
  if (injected) {
    const key = Buffer.from(injected, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${ENV_KEY} must be ${KEY_BYTES} bytes of base64 (got ${key.length}). Generate one ` +
          `with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    cachedKey = key;
    return key;
  }

  const path = masterKeyPath();
  if (existsSync(path)) return adopt(readFileSync(path), path);

  mkdirSync(dirname(path), { recursive: true });
  const generated = randomBytes(KEY_BYTES);
  try {
    // 'wx' fails rather than clobbering: if a second process generated a key
    // between the existsSync above and here, that key already sealed rows and
    // overwriting it would make every stored credential undecryptable.
    writeFileSync(path, generated, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (existsSync(path)) return adopt(readFileSync(path), path);
    throw err;
  }

  try {
    // writeFileSync's mode is subject to the process umask, so restate it.
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the file inherits the user's ACL, which
    // is the best available protection there. Not worth failing startup over.
  }

  cachedKey = generated;
  return generated;
}

function adopt(raw: Buffer, path: string): Buffer {
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `Master key at ${path} is ${raw.length} bytes; expected ${KEY_BYTES}. ` +
        'Restore the original file — credentials sealed with it cannot be read without it.',
    );
  }
  cachedKey = raw;
  return raw;
}

export function seal(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, ensureMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/**
 * Throws — never returns a garbage string — when the auth tag does not verify.
 * That failure is the signal that the master key was swapped or rotated out
 * from under the database, and it must be loud rather than surfacing later as
 * a mysterious 401 from a provider.
 */
export function open(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
  if (iv.length !== IV_BYTES) {
    throw new Error(`Sealed value has a ${iv.length}-byte IV; expected ${IV_BYTES}.`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `Sealed value has a ${authTag.length}-byte auth tag; expected ${AUTH_TAG_BYTES}.`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, ensureMasterKey(), iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately drops the underlying error and every byte of the payload:
    // the only actionable fact is which key was tried.
    throw new Error(
      `Could not decrypt a stored secret with the master key at ${masterKeyPath()}. ` +
        'The key was replaced or rotated — restore it, or delete and re-enter the credential.',
    );
  }
}

/** Drops the cached key so a rotated master.key is picked up without a restart. */
export function reloadMasterKey(): Buffer {
  cachedKey = null;
  return ensureMasterKey();
}
