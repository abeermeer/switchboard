import type { Settings } from '@/types/core';
import { getDb, parseJson, transact } from '@/lib/db/client';
import { asRows, num, str } from '@/lib/db/rows';

export const DEFAULT_SETTINGS: Settings = {
  defaultCombo: 'auto',
  preferFreeTiers: true,
  logPayloads: true,
  logRetentionDays: 30,
  healthProbeIntervalSec: 120,
  breakerFailureThreshold: 4,
  breakerCooldownMs: 30_000,
  defaultTimeoutMs: 120_000,
  theme: 'system',
};

const THEMES: readonly Settings['theme'][] = ['light', 'dark', 'system'];

/**
 * Values are stored as JSON, but a hand-edited row (or an older build that wrote
 * bare strings) must not break the dashboard, so an unparseable value falls back
 * to the raw text and is coerced from there.
 */
function decode(raw: string): unknown {
  return parseJson<unknown>(raw, raw);
}

function readBool(stored: Map<string, string>, key: keyof Settings, fallback: boolean): boolean {
  const raw = stored.get(key);
  if (raw === undefined) return fallback;
  const value = decode(raw);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
    if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  }
  return fallback;
}

function readInt(stored: Map<string, string>, key: keyof Settings, fallback: number): number {
  const raw = stored.get(key);
  if (raw === undefined) return fallback;
  const value = num(decode(raw), Number.NaN);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.round(value);
}

function readString(stored: Map<string, string>, key: keyof Settings, fallback: string): string {
  const raw = stored.get(key);
  if (raw === undefined) return fallback;
  const value = decode(raw);
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

export function getSettings(): Settings {
  const rows = asRows(getDb().prepare('SELECT key, value FROM settings').all());
  const stored = new Map<string, string>();
  for (const row of rows) {
    const key = str(row.key);
    if (key) stored.set(key, str(row.value));
  }

  const themeRaw = stored.get('theme');
  const theme = themeRaw === undefined ? DEFAULT_SETTINGS.theme : decode(themeRaw);

  return {
    defaultCombo: readString(stored, 'defaultCombo', DEFAULT_SETTINGS.defaultCombo),
    preferFreeTiers: readBool(stored, 'preferFreeTiers', DEFAULT_SETTINGS.preferFreeTiers),
    logPayloads: readBool(stored, 'logPayloads', DEFAULT_SETTINGS.logPayloads),
    logRetentionDays: readInt(stored, 'logRetentionDays', DEFAULT_SETTINGS.logRetentionDays),
    healthProbeIntervalSec: readInt(
      stored,
      'healthProbeIntervalSec',
      DEFAULT_SETTINGS.healthProbeIntervalSec,
    ),
    breakerFailureThreshold: readInt(
      stored,
      'breakerFailureThreshold',
      DEFAULT_SETTINGS.breakerFailureThreshold,
    ),
    breakerCooldownMs: readInt(stored, 'breakerCooldownMs', DEFAULT_SETTINGS.breakerCooldownMs),
    defaultTimeoutMs: readInt(stored, 'defaultTimeoutMs', DEFAULT_SETTINGS.defaultTimeoutMs),
    theme:
      typeof theme === 'string' && (THEMES as readonly string[]).includes(theme)
        ? (theme as Settings['theme'])
        : DEFAULT_SETTINGS.theme,
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const writes: Array<[string, string]> = [];
  const put = (key: keyof Settings, value: string | number | boolean): void => {
    writes.push([key, JSON.stringify(value)]);
  };
  const putInt = (key: keyof Settings, value: number, fallback: number): void => {
    put(key, Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback);
  };

  if (patch.defaultCombo !== undefined) {
    const slug = patch.defaultCombo.trim();
    put('defaultCombo', slug === '' ? DEFAULT_SETTINGS.defaultCombo : slug);
  }
  if (patch.preferFreeTiers !== undefined) put('preferFreeTiers', patch.preferFreeTiers);
  if (patch.logPayloads !== undefined) put('logPayloads', patch.logPayloads);
  if (patch.logRetentionDays !== undefined) {
    putInt('logRetentionDays', patch.logRetentionDays, DEFAULT_SETTINGS.logRetentionDays);
  }
  if (patch.healthProbeIntervalSec !== undefined) {
    putInt(
      'healthProbeIntervalSec',
      patch.healthProbeIntervalSec,
      DEFAULT_SETTINGS.healthProbeIntervalSec,
    );
  }
  if (patch.breakerFailureThreshold !== undefined) {
    putInt(
      'breakerFailureThreshold',
      patch.breakerFailureThreshold,
      DEFAULT_SETTINGS.breakerFailureThreshold,
    );
  }
  if (patch.breakerCooldownMs !== undefined) {
    putInt('breakerCooldownMs', patch.breakerCooldownMs, DEFAULT_SETTINGS.breakerCooldownMs);
  }
  if (patch.defaultTimeoutMs !== undefined) {
    putInt('defaultTimeoutMs', patch.defaultTimeoutMs, DEFAULT_SETTINGS.defaultTimeoutMs);
  }
  if (patch.theme !== undefined && (THEMES as readonly string[]).includes(patch.theme)) {
    put('theme', patch.theme);
  }

  if (writes.length > 0) {
    transact((handle) => {
      const stmt = handle.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      for (const [key, value] of writes) stmt.run(key, value);
    });
  }

  return getSettings();
}
