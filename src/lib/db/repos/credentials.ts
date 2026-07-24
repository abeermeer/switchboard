import { getDb } from '@/lib/db/client';
import { asRow, asRows, str } from '@/lib/db/rows';
import { open, seal } from '@/lib/crypto/vault';

/** node:sqlite hands BLOB columns back as views; GCM needs real Buffers. */
function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/**
 * Seals `plaintext` for `connectionId`, replacing any existing credential.
 *
 * The plaintext is never logged, never returned, and never stored — only the
 * ciphertext and a 4-character tail the dashboard can show as "…a1b2".
 */
export function setCredential(connectionId: string, plaintext: string): void {
  const secret = plaintext.trim();
  if (secret === '') throw new Error('setCredential requires a non-empty value');

  const { ciphertext, iv, authTag } = seal(secret);

  getDb()
    .prepare(
      `INSERT INTO credentials (connection_id, ciphertext, iv, auth_tag, hint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv         = excluded.iv,
         auth_tag   = excluded.auth_tag,
         hint       = excluded.hint,
         updated_at = excluded.updated_at`,
    )
    .run(connectionId, ciphertext, iv, authTag, secret.slice(-4), Date.now());
}

/**
 * Returns the decrypted credential, or null when the connection has none.
 *
 * A tampered or unreadable row propagates the vault's error rather than
 * degrading to null: null means "keyless provider" to every caller, so
 * swallowing it here would send unauthenticated requests upstream and report
 * the provider's 401 instead of the real cause.
 */
export function getCredential(connectionId: string): string | null {
  const row = asRow(
    getDb()
      .prepare('SELECT ciphertext, iv, auth_tag FROM credentials WHERE connection_id = ?')
      .get(connectionId),
  );
  if (!row) return null;

  const ciphertext = toBuffer(row.ciphertext);
  const iv = toBuffer(row.iv);
  const authTag = toBuffer(row.auth_tag);
  if (!ciphertext || !iv || !authTag) {
    throw new Error(`Credential row for ${connectionId} is corrupt: expected BLOB columns.`);
  }

  return open(ciphertext, iv, authTag);
}

export function hasCredential(connectionId: string): boolean {
  const row = asRow(
    getDb()
      .prepare('SELECT 1 AS present FROM credentials WHERE connection_id = ?')
      .get(connectionId),
  );
  return row !== null;
}

/** Last 4 characters of the stored secret, for display only. */
export function getCredentialHint(connectionId: string): string | null {
  const row = asRow(
    getDb().prepare('SELECT hint FROM credentials WHERE connection_id = ?').get(connectionId),
  );
  if (!row) return null;
  const hint = str(row.hint);
  return hint === '' ? null : hint;
}

export function deleteCredential(connectionId: string): void {
  getDb().prepare('DELETE FROM credentials WHERE connection_id = ?').run(connectionId);
}

/** Connection ids that currently hold a credential; one query for list views. */
export function listCredentialedConnectionIds(): Set<string> {
  const ids = new Set<string>();
  for (const row of asRows(getDb().prepare('SELECT connection_id FROM credentials').all())) {
    const value = str(row.connection_id);
    if (value) ids.add(value);
  }
  return ids;
}

/** True when a credential exists and still opens with the current master key. */
export function verifyCredential(connectionId: string): boolean {
  try {
    return getCredential(connectionId) !== null;
  } catch {
    return false;
  }
}
