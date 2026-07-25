/**
 * Structured logging with redaction.
 *
 * Purpose-built rather than pino, for two reasons specific to this project.
 * Next bundles server code and pino's worker-thread transports are a known
 * friction point there; and the redaction rules are the security-critical part,
 * which has to be written for this codebase either way. What is left after that
 * is JSON serialization and level filtering, which is small enough to own — and
 * owning it means the redaction can be tested exhaustively rather than trusted.
 *
 * Output is one JSON object per line on stdout (stderr for `error`), which is
 * what every log shipper expects and what `jq` reads without configuration. In
 * a TTY it prints a human-readable line instead, because a developer running
 * `npm run dev` is the actual reader there.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values are never safe to print. Matched case-insensitively
 * against the whole key, so `apiKey`, `api_key`, `x-api-key` and
 * `Authorization` all hit.
 */
const SECRET_KEY_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|bearer|credential|master[-_]?key|key[-_]?hash|cookie|set-cookie)$/i;

/**
 * Values that look like a credential even under an innocent key name — someone
 * logging `{ note: "use sk-proj-abc..." }` should not leak it.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsb-live-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9_-]{16,}/g,
  /\bcsk_[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
];

export const REDACTED = '[redacted]';

/** How deep to walk a value before giving up; guards against cyclic input. */
const MAX_DEPTH = 6;

/**
 * Strips anything that could be a credential.
 *
 * Deliberately conservative: it would rather blank a harmless field than print
 * a live key. Applied to every logged value, including nested objects and
 * arrays, so a caller cannot leak by accident.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // Stacks carry file paths, not secrets, but they can carry an interpolated
      // URL with a query-string key.
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    };
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }

  // Functions, symbols: never useful in a log line.
  return undefined;
}

function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Each pattern carries /g, and lastIndex persists across calls on a shared
    // regex — reset so a match in one string cannot make the next one miss.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function configuredLevel(): LogLevel {
  const raw = process.env.SWITCHBOARD_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  if (process.env.SWITCHBOARD_LOG_LEVEL === 'silent') return 'error';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function useJson(): boolean {
  if (process.env.SWITCHBOARD_LOG_FORMAT === 'json') return true;
  if (process.env.SWITCHBOARD_LOG_FORMAT === 'pretty') return false;
  // A TTY means a human is reading; anything else is being captured.
  return !process.stdout.isTTY;
}

/**
 * Read per call rather than cached at module load, so a test (or a running
 * process) can change the level after this module has been imported. A
 * load-time constant would mean the value depends on import order.
 */
function isSilent(): boolean {
  return process.env.SWITCHBOARD_LOG_LEVEL === 'silent';
}

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  /** Returns a logger that stamps `bindings` onto every line it writes. */
  child: (bindings: Record<string, unknown>) => Logger;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '[2m',
  info: '[36m',
  warn: '[33m',
  error: '[31m',
};

function write(level: LogLevel, message: string, bindings: Record<string, unknown>, fields?: Record<string, unknown>): void {
  if (isSilent()) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const merged = { ...bindings, ...(fields ?? {}) };
  const safe = redact(merged) as Record<string, unknown>;
  const stream = level === 'error' ? process.stderr : process.stdout;

  if (useJson()) {
    stream.write(
      `${JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg: redactString(message),
        ...safe,
      })}\n`,
    );
    return;
  }

  const colour = LEVEL_COLOR[level];
  const reset = '[0m';
  const detail = Object.entries(safe)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');

  stream.write(
    `${colour}${level.padEnd(5)}${reset} ${redactString(message)}${detail.length > 0 ? ` [2m${detail}${reset}` : ''}\n`,
  );
}

function make(bindings: Record<string, unknown>): Logger {
  return {
    debug: (message, fields) => write('debug', message, bindings, fields),
    info: (message, fields) => write('info', message, bindings, fields),
    warn: (message, fields) => write('warn', message, bindings, fields),
    error: (message, fields) => write('error', message, bindings, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger: Logger = make({});

/**
 * A logger bound to one gateway request. The fields are the ones worth having
 * when reconstructing what happened after the fact.
 */
export function requestLogger(input: {
  requestId: string;
  modality?: string;
  requestedModel?: string;
  apiKeyId?: string | null;
}): Logger {
  return logger.child({
    requestId: input.requestId,
    ...(input.modality === undefined ? {} : { modality: input.modality }),
    ...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }),
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
  });
}
