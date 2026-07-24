import type {
  AdapterError,
  AdapterResponse,
  ApiKey,
  CatalogModel,
  ChatFeature,
  Connection,
  ConnectionView,
  Modality,
  RoutingDecision,
} from '@/types/core';
import { listConnections } from '@/lib/db/repos/connections';
import { hasCredential } from '@/lib/db/repos/credentials';
import { usageByConnection } from '@/lib/db/repos/usage';
import { getSettings } from '@/lib/db/repos/settings';
import { snapshotAll } from '@/lib/resilience/breaker';
import { getProvider, inferTier, listModelsFor } from '@/lib/providers/registry';
import { checkBudget } from '@/lib/auth/budget';
import { estimateInputTokens } from '@/lib/usage/cost';
import { id } from '@/lib/utils';
import { expandCandidates } from './candidates';
import { scoreCandidates } from './score';
import { executeRoute } from './execute';
import { requestedMaxOutput } from './estimate';

export interface RouteInput {
  modality: Modality;
  requestedModel: string;
  body: Record<string, unknown>;
  stream: boolean;
  apiKey: ApiKey | null;
  signal: AbortSignal;
  requiredFeatures?: ChatFeature[];
}

export interface RouteResult {
  response: AdapterResponse | null;
  decision: RoutingDecision;
  error: AdapterError | null;
}

/** Rotates round-robin selection across requests within this process. */
let rotationCounter = 0;

export async function route(input: RouteInput): Promise<RouteResult> {
  const startedAt = Date.now();
  const requestId = id('req');
  const settings = getSettings();

  // An over-budget key is not an error by default: dropping it to free
  // providers keeps the client working instead of breaking their app at 2am.
  const budget = input.apiKey === null ? null : checkBudget(input.apiKey);
  const freeOnly = budget?.state === 'downgrade';

  const inputTokens = estimateInputTokens(input.body);
  const maxOutput = requestedMaxOutput(input.body);

  const expanded = expandCandidates({
    modality: input.modality,
    requestedModel: input.requestedModel,
    inputTokens,
    maxOutput,
    requiredFeatures: input.requiredFeatures ?? [],
    freeOnly,
    apiKey: input.apiKey,
  });

  const strategy = expanded.combo?.strategy ?? (settings.preferFreeTiers ? 'free-first' : 'fastest');

  rotationCounter += 1;
  const ranked = scoreCandidates(expanded.candidates, strategy, {
    strategy,
    combo: expanded.combo,
    rotation: rotationCounter,
  });

  const baseDecision: RoutingDecision = {
    requestId,
    requestedModel: input.requestedModel,
    comboId: expanded.combo?.id ?? null,
    strategy,
    modality: input.modality,
    candidates: ranked,
    attempts: [],
    winningAttempt: null,
    totalDurationMs: 0,
    decidedAt: startedAt,
  };

  if (expanded.hardError !== null) {
    return {
      response: null,
      decision: { ...baseDecision, totalDurationMs: Date.now() - startedAt },
      error: { kind: 'unsupported', message: expanded.hardError, retryAfterSec: null, raw: null },
    };
  }

  if (budget?.state === 'blocked') {
    return {
      response: null,
      decision: { ...baseDecision, totalDurationMs: Date.now() - startedAt },
      error: {
        kind: 'quota_exceeded',
        message: `Monthly budget of $${budget.limitUsd?.toFixed(2) ?? '0.00'} exhausted for this API key.`,
        retryAfterSec: null,
        raw: null,
      },
    };
  }

  const executed = await executeRoute({
    candidates: ranked,
    modality: input.modality,
    body: input.body,
    stream: input.stream,
    signal: input.signal,
    maxAttempts: expanded.combo?.maxAttempts ?? 4,
    timeoutMs: expanded.combo?.timeoutMs ?? settings.defaultTimeoutMs,
  });

  return {
    response: executed.response,
    decision: {
      ...baseDecision,
      attempts: executed.attempts,
      winningAttempt: executed.winningAttempt,
      totalDurationMs: Date.now() - startedAt,
    },
    error: executed.error,
  };
}

/** Everything the dashboard needs to render one provider row, in one pass. */
export function buildConnectionViews(): ConnectionView[] {
  const connections = listConnections();
  const health = snapshotAll();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const usage = usageByConnection(dayAgo);

  const views: ConnectionView[] = [];

  for (const connection of connections) {
    const provider = getProvider(connection.providerId);
    if (provider === null) continue;

    const credentialed = !provider.requiresKey || hasCredential(connection.id);

    // A connection with a credential but no health row has simply never been
    // used. The router already treats it as available (the breaker is closed
    // and successRate defaults to 1), so reporting it as healthy is what
    // actually happens — calling it "unconfigured" would contradict routing.
    const snapshot = health[connection.id] ?? {
      connectionId: connection.id,
      status: credentialed ? ('healthy' as const) : ('unconfigured' as const),
      breaker: 'closed' as const,
      successRate: 1,
      p50LatencyMs: null,
      p95LatencyMs: null,
      consecutiveFailures: 0,
      openedAt: null,
      cooldownUntil: null,
      lastCheckedAt: null,
      lastError: null,
    };

    const status = !connection.enabled
      ? ('disabled' as const)
      : !credentialed
        ? ('unconfigured' as const)
        : snapshot.status;

    views.push({
      ...connection,
      provider,
      status,
      hasCredential: credentialed,
      tier: connection.tierOverride ?? inferTier(provider, null),
      health: { ...snapshot, status },
      usage: usage[connection.id] ?? {
        requests: 0,
        successes: 0,
        failures: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        savedUsd: 0,
      },
    });
  }

  views.sort((a, b) => {
    const rank = { healthy: 0, degraded: 1, down: 2, unconfigured: 3, disabled: 4 };
    const diff = rank[a.status] - rank[b.status];
    if (diff !== 0) return diff;
    return b.usage.requests - a.usage.requests;
  });

  return views;
}

export interface AvailableModel {
  id: string;
  ownedBy: string;
  connectionId: string;
  model: CatalogModel;
}

/**
 * The model list clients see on /v1/models. A model offered by several
 * providers appears once, attributed to the healthiest connection serving it —
 * the duplicate providers are the fallback chain, not extra menu entries.
 */
export function listAvailableModels(modality?: Modality): AvailableModel[] {
  const health = snapshotAll();
  const best = new Map<string, { entry: AvailableModel; rank: number }>();

  const statusRank: Record<string, number> = {
    healthy: 0,
    degraded: 1,
    unconfigured: 2,
    down: 3,
    disabled: 4,
  };

  for (const connection of listConnections()) {
    if (!connection.enabled) continue;
    const provider = getProvider(connection.providerId);
    if (provider === null) continue;
    if (provider.requiresKey && !hasCredential(connection.id)) continue;

    const status = health[connection.id]?.status ?? 'unconfigured';
    const rank = statusRank[status] ?? 5;

    for (const model of listModelsFor(provider.id, modality)) {
      const existing = best.get(model.id);
      if (existing === undefined || rank < existing.rank) {
        best.set(model.id, {
          rank,
          entry: { id: model.id, ownedBy: provider.id, connectionId: connection.id, model },
        });
      }
    }
  }

  return [...best.values()]
    .map((v) => v.entry)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Connections that can serve a given model, for the models page. */
export function connectionsServing(modelId: string): Connection[] {
  return listConnections().filter((connection) => {
    const provider = getProvider(connection.providerId);
    if (provider === null) return false;
    return provider.models.some((m) => m.id === modelId);
  });
}

export { expandCandidates } from './candidates';
export { scoreCandidates, STRATEGY_WEIGHTS } from './score';
