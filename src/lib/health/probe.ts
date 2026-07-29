import type { AdapterError } from '@/types/core';
import { getConnection, listConnections } from '@/lib/db/repos/connections';
import { getCredential, hasCredential } from '@/lib/db/repos/credentials';
import {
  clearExpiredLockouts,
  getHealthRow,
  pruneLatencySamples,
  upsertHealthRow,
} from '@/lib/db/repos/health';
import { pruneLogs } from '@/lib/db/repos/log';
import { getSettings } from '@/lib/db/repos/settings';
import { getAdapter, getProvider } from '@/lib/providers/registry';
import { onFailure, onSuccess } from '@/lib/resilience/breaker';
import { logger } from '@/lib/logger';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

/**
 * Probes hit a listing endpoint, not a completion, so their timings are tagged
 * apart from real traffic — a dashboard showing "180ms" should be able to say
 * whether that came from a keepalive ping or from an actual generation.
 */
const PROBE_MODEL_ID = '__probe__';

/** Adapters time their own probes out; this is only a backstop against a wedged one. */
const PROBE_ABORT_MS = 20_000;

const SAMPLE_RETENTION_MS = 86_400_000;

const DAY_MS = 86_400_000;

/**
 * Applies the operator's `logRetentionDays` setting.
 *
 * Nothing enforced it before: the field was settable, stored and displayed, and
 * the only caller of `pruneLogs` was a button in the dashboard. Payload logging
 * is on by default, so "keep 30 days" quietly meant "keep every prompt and
 * completion forever". Runs on the health tick because that loop already exists
 * and is already the place bounded housekeeping happens.
 */
function enforceLogRetention(): void {
  try {
    const days = getSettings().logRetentionDays;
    // 0 means "keep forever", which is a legitimate choice rather than a bug.
    if (!Number.isFinite(days) || days <= 0) return;

    const removed = pruneLogs(Date.now() - days * DAY_MS);
    if (removed > 0) {
      logger.info('pruned expired request logs', { removed, retentionDays: days });
    }
  } catch (err) {
    // Housekeeping must never take the probe loop down with it.
    logger.warn('log retention sweep failed', { err });
  }
}

/** Node's timers can be unref'd so a background loop never holds the process open. */
function unref(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null) return;
  const candidate = (timer as { unref?: unknown }).unref;
  if (typeof candidate === 'function') (candidate as () => void).call(timer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unref(setTimeout(resolve, ms));
  });
}

const HTTP_STATUS_RE = /HTTP (\d{3})/;

/**
 * The adapter contract gives probes a plain string, but the breaker reasons in
 * error kinds — a 401 has to open the connection while a 429 only parks one
 * model. The status code the adapters prefix onto the message carries enough to
 * recover that distinction.
 */
function probeErrorToAdapterError(message: string): AdapterError {
  const status = Number(HTTP_STATUS_RE.exec(message)?.[1] ?? Number.NaN);
  const base = { message, retryAfterSec: null, raw: message };

  if (status === 401 || status === 403) return { ...base, kind: 'auth' };
  if (status === 402) return { ...base, kind: 'quota_exceeded' };
  if (status === 429) return { ...base, kind: 'rate_limit' };
  if (status >= 500) return { ...base, kind: 'server' };
  if (/timed out|timeout|aborted/i.test(message)) return { ...base, kind: 'timeout' };
  if (Number.isFinite(status)) return { ...base, kind: 'unknown' };
  return { ...base, kind: 'network' };
}

/** Records the outcome without letting a storage hiccup escape to the caller. */
function stampCheck(connectionId: string, error: string | null): void {
  try {
    upsertHealthRow({ ...getHealthRow(connectionId), lastCheckedAt: Date.now(), lastError: error });
  } catch {
    // The connection was deleted while its probe was in flight.
  }
}

export async function probeConnection(connectionId: string): Promise<ProbeResult> {
  const connection = getConnection(connectionId);
  if (connection === null) {
    return { ok: false, latencyMs: 0, error: 'Connection not found' };
  }

  const provider = getProvider(connection.providerId);
  if (provider === null) {
    const error = `Unknown provider "${connection.providerId}"`;
    stampCheck(connectionId, error);
    return { ok: false, latencyMs: 0, error };
  }

  let credential: string | null = null;
  if (provider.requiresKey) {
    try {
      credential = getCredential(connectionId);
    } catch (err) {
      // A credential that will not decrypt is a real, reportable fault: the
      // master key changed or the row was tampered with.
      const error = err instanceof Error ? err.message : String(err);
      stampCheck(connectionId, error);
      return { ok: false, latencyMs: 0, error };
    }
    if (credential === null) {
      const error = 'No credential configured';
      stampCheck(connectionId, error);
      return { ok: false, latencyMs: 0, error };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Probe timed out', 'TimeoutError'));
  }, PROBE_ABORT_MS);
  unref(timer);

  let result: ProbeResult;
  try {
    result = await getAdapter(provider.kind).probe({
      signal: controller.signal,
      connection,
      provider,
      credential,
    });
  } catch (err) {
    result = {
      ok: false,
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  if (result.ok) {
    onSuccess(connectionId, PROBE_MODEL_ID, null, result.latencyMs);
  } else {
    const message = result.error ?? 'Probe failed';
    onFailure(connectionId, PROBE_MODEL_ID, probeErrorToAdapterError(message), result.latencyMs);
  }

  // Written after the breaker so its own row update is not clobbered.
  stampCheck(connectionId, result.ok ? null : result.error);
  return result;
}

/** Connections worth probing: switched on, and holding whatever key they need. */
function probeTargets(): string[] {
  const targets: string[] = [];
  for (const connection of listConnections()) {
    if (!connection.enabled) continue;
    const provider = getProvider(connection.providerId);
    if (provider === null) continue;
    if (provider.requiresKey && !hasCredential(connection.id)) continue;
    targets.push(connection.id);
  }
  return targets;
}

export async function probeAll(): Promise<Record<string, ProbeResult>> {
  const out: Record<string, ProbeResult> = {};
  // Sequential on purpose: a handful of providers is not worth a worker pool,
  // and firing every probe at once is exactly the burst the scheduler avoids.
  for (const connectionId of probeTargets()) {
    out[connectionId] = await probeConnection(connectionId);
  }
  return out;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  kickoff: ReturnType<typeof setTimeout> | null;
  intervalSec: number;
  /** Bumped by every stop, so an in-flight round knows to abandon itself. */
  generation: number;
  running: boolean;
}

/** Next.js re-evaluates modules across HMR boundaries; the timer must not. */
const globalState = globalThis as { __switchboardHealthScheduler?: SchedulerState };

function state(): SchedulerState {
  const existing = globalState.__switchboardHealthScheduler;
  if (existing !== undefined) return existing;
  const created: SchedulerState = {
    timer: null,
    kickoff: null,
    intervalSec: 0,
    generation: 0,
    running: false,
  };
  globalState.__switchboardHealthScheduler = created;
  return created;
}

/** Spread probes across the interval instead of bursting them in one tick. */
function spacingMs(intervalMs: number, count: number): number {
  if (count <= 1) return 0;
  // Two thirds of the interval leaves headroom for the probes themselves.
  return Math.min(Math.floor((intervalMs * 0.66) / count), 15_000);
}

async function runRound(generation: number, intervalMs: number): Promise<void> {
  const current = state();
  if (current.running || current.generation !== generation) return;
  current.running = true;

  try {
    clearExpiredLockouts();
    pruneLatencySamples(SAMPLE_RETENTION_MS);
    enforceLogRetention();

    const targets = probeTargets();
    const gap = spacingMs(intervalMs, targets.length);

    for (let index = 0; index < targets.length; index += 1) {
      if (current.generation !== generation) return;
      const connectionId = targets[index];
      if (connectionId === undefined) continue;

      if (index > 0 && gap > 0) await sleep(gap);
      if (current.generation !== generation) return;

      // One bad connection must not abort the round for the others.
      await probeConnection(connectionId).catch(() => undefined);
    }
  } catch {
    // A failed round is not fatal; the next tick tries again.
  } finally {
    current.running = false;
  }
}

/**
 * Starts the background prober. Safe to call repeatedly: an unchanged interval
 * is a no-op, a changed one restarts cleanly, and zero means "do not probe".
 */
export function startHealthScheduler(): void {
  const intervalSec = getSettings().healthProbeIntervalSec;
  const current = state();

  if (intervalSec <= 0) {
    stopHealthScheduler();
    return;
  }
  if (current.timer !== null && current.intervalSec === intervalSec) return;

  stopHealthScheduler();

  const intervalMs = intervalSec * 1_000;
  const generation = current.generation;
  current.intervalSec = intervalSec;

  // A short delay rather than an immediate round, so importing this module
  // never blocks app startup on network I/O.
  const kickoff = setTimeout(() => {
    void runRound(generation, intervalMs);
  }, 2_000);
  unref(kickoff);
  current.kickoff = kickoff;

  const timer = setInterval(() => {
    void runRound(generation, intervalMs);
  }, intervalMs);
  unref(timer);
  current.timer = timer;
}

export function stopHealthScheduler(): void {
  const current = state();

  if (current.timer !== null) clearInterval(current.timer);
  if (current.kickoff !== null) clearTimeout(current.kickoff);

  current.timer = null;
  current.kickoff = null;
  current.intervalSec = 0;
  // Signals any round still mid-flight to stop before its next probe.
  current.generation += 1;
}
