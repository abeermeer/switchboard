/**
 * Switchboard — database schema.
 *
 * Migrations are append-only. Never edit a shipped migration; add a new one.
 * `runMigrations` in ./client.ts applies anything newer than `user_version`.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
    -- Configured provider instances ------------------------------------------
    CREATE TABLE connections (
      id                 TEXT PRIMARY KEY,
      provider_id        TEXT NOT NULL,
      label              TEXT NOT NULL,
      enabled            INTEGER NOT NULL DEFAULT 1,
      tier_override      TEXT,
      priority           INTEGER NOT NULL DEFAULT 100,
      base_url_override  TEXT,
      monthly_budget_usd REAL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX idx_connections_provider ON connections(provider_id);
    CREATE INDEX idx_connections_enabled  ON connections(enabled);

    -- AES-256-GCM sealed credentials. The plaintext never touches disk. ------
    CREATE TABLE credentials (
      connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
      ciphertext    BLOB NOT NULL,
      iv            BLOB NOT NULL,
      auth_tag      BLOB NOT NULL,
      hint          TEXT NOT NULL,   -- last 4 chars, for the UI
      updated_at    INTEGER NOT NULL
    );

    -- Named routing policies -------------------------------------------------
    CREATE TABLE combos (
      id                  TEXT PRIMARY KEY,
      slug                TEXT NOT NULL UNIQUE,
      name                TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      modality            TEXT NOT NULL DEFAULT 'chat',
      strategy            TEXT NOT NULL DEFAULT 'free-first',
      requires            TEXT NOT NULL DEFAULT '[]',
      max_cost_per_mtok   REAL,
      max_attempts        INTEGER NOT NULL DEFAULT 4,
      timeout_ms          INTEGER NOT NULL DEFAULT 120000,
      enabled             INTEGER NOT NULL DEFAULT 1,
      is_default          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE TABLE combo_members (
      combo_id      TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      model_id      TEXT NOT NULL,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      weight        INTEGER NOT NULL DEFAULT 1,
      enabled       INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (combo_id, connection_id, model_id)
    );

    -- Client-facing API keys. Only the hash is stored. -----------------------
    CREATE TABLE api_keys (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      prefix               TEXT NOT NULL,
      key_hash             TEXT NOT NULL UNIQUE,
      allowed_combos       TEXT NOT NULL DEFAULT '[]',
      monthly_budget_usd   REAL,
      on_budget_exceeded   TEXT NOT NULL DEFAULT 'downgrade-to-free',
      rate_limit_per_min   INTEGER,
      enabled              INTEGER NOT NULL DEFAULT 1,
      created_at           INTEGER NOT NULL,
      last_used_at         INTEGER,
      expires_at           INTEGER
    );
    CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

    -- Simple key/value settings store ---------------------------------------
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Live health, one row per connection ------------------------------------
    CREATE TABLE health (
      connection_id        TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
      status               TEXT NOT NULL DEFAULT 'unconfigured',
      breaker              TEXT NOT NULL DEFAULT 'closed',
      success_count        INTEGER NOT NULL DEFAULT 0,
      failure_count        INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      p50_latency_ms       REAL,
      p95_latency_ms       REAL,
      opened_at            INTEGER,
      cooldown_until       INTEGER,
      open_count           INTEGER NOT NULL DEFAULT 0,
      last_checked_at      INTEGER,
      last_error           TEXT
    );

    -- Per-model 429 lockouts, independent of the connection breaker ----------
    CREATE TABLE model_lockouts (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      model_id      TEXT NOT NULL,
      until         INTEGER NOT NULL,
      reason        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (connection_id, model_id)
    );
    CREATE INDEX idx_lockouts_until ON model_lockouts(until);

    -- Rolling latency samples, trimmed by the health scheduler ---------------
    CREATE TABLE latency_samples (
      connection_id TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      ttft_ms       REAL,
      total_ms      REAL NOT NULL,
      ok            INTEGER NOT NULL
    );
    CREATE INDEX idx_latency_conn_ts ON latency_samples(connection_id, ts);

    -- One row per client request --------------------------------------------
    CREATE TABLE request_log (
      id                    TEXT PRIMARY KEY,
      ts                    INTEGER NOT NULL,
      api_key_id            TEXT,
      modality              TEXT NOT NULL,
      requested_model       TEXT NOT NULL,
      resolved_connection_id TEXT,
      resolved_provider_id  TEXT,
      resolved_model_id     TEXT,
      status                TEXT NOT NULL,
      http_status           INTEGER NOT NULL,
      duration_ms           INTEGER NOT NULL,
      ttft_ms               INTEGER,
      streamed              INTEGER NOT NULL DEFAULT 0,
      prompt_tokens         INTEGER NOT NULL DEFAULT 0,
      completion_tokens     INTEGER NOT NULL DEFAULT 0,
      cached_tokens         INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0,
      saved_usd             REAL NOT NULL DEFAULT 0,
      attempt_count         INTEGER NOT NULL DEFAULT 1,
      error                 TEXT,
      client_ip             TEXT,
      user_agent            TEXT
    );
    CREATE INDEX idx_log_ts        ON request_log(ts DESC);
    CREATE INDEX idx_log_status    ON request_log(status, ts DESC);
    CREATE INDEX idx_log_conn      ON request_log(resolved_connection_id, ts DESC);
    CREATE INDEX idx_log_key       ON request_log(api_key_id, ts DESC);

    -- Heavy payloads live apart so the log stays fast to scan ----------------
    CREATE TABLE request_payloads (
      request_id    TEXT PRIMARY KEY REFERENCES request_log(id) ON DELETE CASCADE,
      decision_json TEXT,
      request_json  TEXT,
      response_json TEXT
    );

    -- Hourly rollups so charts never scan the raw log ------------------------
    CREATE TABLE usage_buckets (
      bucket_ts     INTEGER NOT NULL,
      connection_id TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      requests      INTEGER NOT NULL DEFAULT 0,
      successes     INTEGER NOT NULL DEFAULT 0,
      failures      INTEGER NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      saved_usd     REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_ts, connection_id, model_id)
    );
    CREATE INDEX idx_buckets_ts ON usage_buckets(bucket_ts DESC);

    -- Models discovered live from a provider's /models endpoint --------------
    CREATE TABLE discovered_models (
      connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      model_id      TEXT NOT NULL,
      raw_json      TEXT NOT NULL,
      discovered_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, model_id)
    );
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
