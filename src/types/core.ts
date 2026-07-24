/**
 * Switchboard — core domain contract.
 *
 * This file is the single source of truth for every module in the gateway.
 * Nothing in here imports from anywhere else, and everything else imports from
 * here. If a shape needs to change, it changes here first.
 */

// ─── Capabilities ────────────────────────────────────────────────────────────

/** A kind of work a model can do. Routing never crosses modality boundaries. */
export type Modality =
  | 'chat'
  | 'embeddings'
  | 'images'
  | 'audio.speech'
  | 'audio.transcription'
  | 'rerank'
  | 'moderation';

/** Optional abilities within the `chat` modality that routing can require. */
export type ChatFeature = 'tools' | 'vision' | 'json_mode' | 'reasoning' | 'streaming' | 'prefill';

// ─── Providers ───────────────────────────────────────────────────────────────

/** Which adapter implementation speaks to this provider's wire format. */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'google' | 'cohere';

/** How the credential is attached to an upstream request. */
export type AuthScheme = 'bearer' | 'header' | 'query' | 'none';

export interface FreeTier {
  /** Human summary shown in the dashboard, e.g. "14,400 req/day, no card". */
  summary: string;
  /** Requests per day the free tier allows, or null when unmetered/unknown. */
  requestsPerDay: number | null;
  /** Tokens per minute cap, or null when not published. */
  tokensPerMinute: number | null;
  /** True when the provider never asks for a payment method. */
  noCardRequired: boolean;
}

export interface CatalogModel {
  /** Provider-native model id sent upstream, e.g. "llama-3.3-70b-versatile". */
  id: string;
  /** Display name, e.g. "Llama 3.3 70B". */
  name: string;
  modality: Modality;
  /** Features this model supports within its modality. */
  features: ChatFeature[];
  /** Max input context in tokens. */
  contextWindow: number;
  /** Max tokens the model will emit in one response. */
  maxOutput: number;
  /** USD per 1M input tokens. 0 means free at this provider. */
  inputCostPerMTok: number;
  /** USD per 1M output tokens. 0 means free at this provider. */
  outputCostPerMTok: number;
  /** Rough tokens/sec, used as a latency prior before real data exists. */
  throughputPrior: number;
}

export interface ProviderCatalogEntry {
  /** Stable slug, e.g. "groq". Used as a foreign key everywhere. */
  id: string;
  name: string;
  kind: ProviderKind;
  /** Base URL with no trailing slash, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string;
  authScheme: AuthScheme;
  /** Header name when authScheme is 'header', e.g. "x-api-key". */
  authHeaderName?: string;
  /** Query param name when authScheme is 'query', e.g. "key". */
  authQueryParam?: string;
  /** Static headers every request to this provider needs. */
  extraHeaders?: Record<string, string>;
  /** Path (relative to baseUrl) that lists models, when the provider has one. */
  modelsPath?: string;
  docsUrl: string;
  signupUrl: string;
  freeTier: FreeTier | null;
  modalities: Modality[];
  models: CatalogModel[];
  /** Brand hex colour, e.g. "#F55036". Drives the dashboard spectrum. */
  accent: string;
  /** False for local runtimes like Ollama that need no credential. */
  requiresKey: boolean;
  /** One-line description shown on the provider card. */
  blurb: string;
}

// ─── Connections (a configured provider + credential) ────────────────────────

export type ConnectionStatus = 'healthy' | 'degraded' | 'down' | 'disabled' | 'unconfigured';

/** Cost class used by the free-first routing ladder. Lower tier wins first. */
export type CostTier = 'free' | 'cheap' | 'standard' | 'premium';

export interface Connection {
  id: string;
  /** FK to ProviderCatalogEntry.id. */
  providerId: string;
  /** User-chosen label, e.g. "Groq (personal)". Defaults to provider name. */
  label: string;
  enabled: boolean;
  /** Manual override of the automatic cost tier, when the user wants one. */
  tierOverride: CostTier | null;
  /** Lower number = tried earlier when scores tie. */
  priority: number;
  /** Overrides catalog baseUrl. Lets one adapter serve self-hosted endpoints. */
  baseUrlOverride: string | null;
  /** Hard ceiling in USD for the current calendar month. null = unlimited. */
  monthlyBudgetUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Connection joined with its live runtime state. What the dashboard renders. */
export interface ConnectionView extends Connection {
  provider: ProviderCatalogEntry;
  status: ConnectionStatus;
  hasCredential: boolean;
  /** Effective tier after applying tierOverride. */
  tier: CostTier;
  health: HealthSnapshot;
  usage: UsageRollup;
}

// ─── Health & resilience ─────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface HealthSnapshot {
  connectionId: string;
  status: ConnectionStatus;
  breaker: BreakerState;
  /** 0..1 rolling success rate over the scoring window. */
  successRate: number;
  /** Median milliseconds to first token over the scoring window. */
  p50LatencyMs: number | null;
  /** 95th percentile milliseconds to first token. */
  p95LatencyMs: number | null;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  /** Epoch ms the breaker opened, or null when closed. */
  openedAt: number | null;
  /** Epoch ms this connection becomes eligible again. */
  cooldownUntil: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

/** Per-model 429 lockout, independent of the connection-level breaker. */
export interface ModelLockout {
  connectionId: string;
  modelId: string;
  until: number;
  reason: string;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export type RoutingStrategy =
  | 'free-first'      // cheapest tier that can serve, then climb
  | 'cost-optimized'  // lowest projected USD for this request
  | 'fastest'         // lowest observed p50 latency
  | 'quality-first'   // highest quality score, cost ignored
  | 'priority'        // strict user-defined order
  | 'round-robin'     // even spread across healthy members
  | 'failover';       // first member, others only on failure

/** A named routing policy. Users call these "combos". */
export interface Combo {
  id: string;
  /** The alias clients send as `model`, e.g. "auto" or "cheap-coder". */
  slug: string;
  name: string;
  description: string;
  modality: Modality;
  strategy: RoutingStrategy;
  members: ComboMember[];
  /** Features a candidate must support to be eligible. */
  requires: ChatFeature[];
  /** Skip candidates whose blended cost exceeds this, in USD per 1M tokens. */
  maxCostPerMTok: number | null;
  /** Give up after this many upstream attempts. */
  maxAttempts: number;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ComboMember {
  connectionId: string;
  /** Provider-native model id, or '*' to let the router pick within it. */
  modelId: string;
  /** Lower is tried first under the 'priority' strategy. */
  order: number;
  /** Relative share under 'round-robin'. */
  weight: number;
  enabled: boolean;
}

/** One candidate the router considered, with the arithmetic behind it. */
export interface RouteCandidate {
  connectionId: string;
  providerId: string;
  modelId: string;
  tier: CostTier;
  /** Final 0..1 score. Higher wins. */
  score: number;
  /** Every factor that fed the score, for the decision-trace UI. */
  factors: ScoreFactor[];
  /** Set when the candidate was removed before scoring. */
  excludedReason: string | null;
  /** Projected USD for this request based on estimated tokens. */
  projectedCostUsd: number;
}

export interface ScoreFactor {
  /** e.g. "health", "cost", "latency", "quota", "priority". */
  name: string;
  /** Raw 0..1 value for this factor. */
  value: number;
  /** How much this factor counted toward the final score. */
  weight: number;
  /** Short human explanation shown on hover in the dashboard. */
  note: string;
}

/** The full record of how one client request was routed. */
export interface RoutingDecision {
  requestId: string;
  /** The `model` the client asked for. */
  requestedModel: string;
  comboId: string | null;
  strategy: RoutingStrategy;
  modality: Modality;
  candidates: RouteCandidate[];
  attempts: RouteAttempt[];
  /** Index into `attempts` that succeeded, or null when all failed. */
  winningAttempt: number | null;
  totalDurationMs: number;
  decidedAt: number;
}

export interface RouteAttempt {
  connectionId: string;
  providerId: string;
  modelId: string;
  startedAt: number;
  durationMs: number;
  /** Milliseconds until the first streamed byte. null for non-streaming. */
  ttftMs: number | null;
  status: 'success' | 'error' | 'timeout' | 'aborted';
  httpStatus: number | null;
  error: string | null;
  /** Why the router moved on, e.g. "429 rate limited", "breaker open". */
  fallbackReason: string | null;
  usage: TokenUsage | null;
  costUsd: number;
}

// ─── Usage & cost ────────────────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cachedTokens: number;
  /** Reasoning tokens billed separately, when reported. */
  reasoningTokens: number;
}

export interface UsageRollup {
  requests: number;
  successes: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Wall-clock ms saved by picking free tiers over the paid baseline. */
  savedUsd: number;
}

export interface UsageBucket extends UsageRollup {
  /** Epoch ms at the start of this bucket. */
  ts: number;
}

// ─── Request log ─────────────────────────────────────────────────────────────

export interface RequestLogEntry {
  id: string;
  ts: number;
  apiKeyId: string | null;
  modality: Modality;
  requestedModel: string;
  resolvedConnectionId: string | null;
  resolvedProviderId: string | null;
  resolvedModelId: string | null;
  status: 'success' | 'error';
  httpStatus: number;
  durationMs: number;
  ttftMs: number | null;
  streamed: boolean;
  usage: TokenUsage | null;
  costUsd: number;
  attemptCount: number;
  error: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

/** Log entry plus the payloads, loaded on demand by the inspector. */
export interface RequestLogDetail extends RequestLogEntry {
  decision: RoutingDecision | null;
  requestBody: unknown;
  responseBody: unknown;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  /** First 12 chars, e.g. "sb-live-4Kx…". The secret itself is never stored. */
  prefix: string;
  /** Combo slugs this key may call. Empty array means all. */
  allowedCombos: string[];
  /** Hard monthly USD ceiling for this key. null = unlimited. */
  monthlyBudgetUsd: number | null;
  /** When the budget is hit: refuse, or silently drop to free providers. */
  onBudgetExceeded: 'block' | 'downgrade-to-free';
  rateLimitPerMin: number | null;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  /** Combo slug used when a client sends an unknown model or "auto". */
  defaultCombo: string;
  /** Global toggle for the free-first ladder. */
  preferFreeTiers: boolean;
  /** Store request/response bodies for the inspector. Off = metadata only. */
  logPayloads: boolean;
  /** Delete log rows older than this. 0 keeps forever. */
  logRetentionDays: number;
  /** Seconds between background health probes. 0 disables probing. */
  healthProbeIntervalSec: number;
  /** Opens the breaker after this many consecutive failures. */
  breakerFailureThreshold: number;
  /** Base cooldown in ms; doubles on each subsequent open. */
  breakerCooldownMs: number;
  /** Default per-attempt timeout when a combo does not override it. */
  defaultTimeoutMs: number;
  theme: 'light' | 'dark' | 'system';
}

// ─── Adapter contract ────────────────────────────────────────────────────────

/** What the router hands an adapter. Already normalized to OpenAI shape. */
export interface AdapterRequest {
  modality: Modality;
  /** Provider-native model id. */
  model: string;
  /** OpenAI-shaped body. The adapter translates it to the provider's format. */
  body: Record<string, unknown>;
  stream: boolean;
  signal: AbortSignal;
  connection: Connection;
  provider: ProviderCatalogEntry;
  /** Decrypted credential, or null for keyless providers. */
  credential: string | null;
}

/** What an adapter hands back. Always OpenAI-shaped, streaming or not. */
export interface AdapterResponse {
  ok: boolean;
  httpStatus: number;
  /** Present when stream === false. */
  json: Record<string, unknown> | null;
  /** Present when stream === true. Already normalized to OpenAI SSE frames. */
  stream: ReadableStream<Uint8Array> | null;
  /** Populated for non-streaming calls, and after a stream drains. */
  usage: TokenUsage | null;
  /** Milliseconds until the first byte arrived. */
  ttftMs: number | null;
  error: AdapterError | null;
  /** Raw upstream headers worth surfacing, e.g. rate-limit remainders. */
  headers: Record<string, string>;
}

export interface AdapterError {
  /** Normalized class the router uses to decide whether to fall back. */
  kind:
    | 'auth'            // 401/403 — credential is bad, do not retry here
    | 'rate_limit'      // 429 — back off this connection, try the next
    | 'quota_exceeded'  // hard cap hit, treat like rate_limit but longer
    | 'context_length'  // request too large for this model, try a bigger one
    | 'bad_request'     // client's fault, do NOT fall back
    | 'server'          // 5xx — fall back
    | 'timeout'
    | 'network'
    | 'unsupported'     // model or feature not available here
    | 'unknown';
  message: string;
  /** Seconds the provider asked us to wait, from Retry-After. */
  retryAfterSec: number | null;
  raw: unknown;
}

/** Every provider adapter implements exactly this. */
export interface ProviderAdapter {
  kind: ProviderKind;
  supports(modality: Modality): boolean;
  execute(req: AdapterRequest): Promise<AdapterResponse>;
  /** Cheap liveness probe used by the health scheduler. */
  probe(req: Omit<AdapterRequest, 'body' | 'stream' | 'modality' | 'model'>): Promise<{
    ok: boolean;
    latencyMs: number;
    error: string | null;
  }>;
}

// ─── Result helper ───────────────────────────────────────────────────────────

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });
