import type {
  ApiKey,
  CatalogModel,
  ChatFeature,
  Combo,
  Connection,
  Modality,
  ProviderCatalogEntry,
  RouteCandidate,
} from '@/types/core';
import { listConnections } from '@/lib/db/repos/connections';
import { hasCredential } from '@/lib/db/repos/credentials';
import { getComboBySlug, getDefaultCombo } from '@/lib/db/repos/combos';
import { isLockedOut } from '@/lib/db/repos/health';
import { monthToDateCostForConnection } from '@/lib/db/repos/usage';
import { isAvailable } from '@/lib/resilience/breaker';
import { findModel, getProvider, inferTier, listModelsFor } from '@/lib/providers/registry';
import { blendedPrice, fitsContext, projectCost } from './estimate';

export interface ExpandInput {
  modality: Modality;
  requestedModel: string;
  inputTokens: number;
  maxOutput: number;
  requiredFeatures: ChatFeature[];
  /** Budget state forces free-only routing without failing the request. */
  freeOnly: boolean;
  apiKey: ApiKey | null;
}

export interface ExpandResult {
  candidates: RouteCandidate[];
  combo: Combo | null;
  modality: Modality;
  /** Set when the model string named a provider that is not configured. */
  hardError: string | null;
}

interface Pairing {
  connection: Connection;
  provider: ProviderCatalogEntry;
  model: CatalogModel;
  /** Explicit order from a combo member list; Infinity when unconstrained. */
  memberOrder: number;
}

/**
 * Turns the client's `model` string into the full set of connection+model pairs
 * that could serve it, each annotated with why it was kept or dropped.
 *
 * Excluded candidates are retained rather than filtered away: the decision
 * trace in the dashboard is only useful if it can show what was rejected and
 * for what reason.
 */
export function expandCandidates(input: ExpandInput): ExpandResult {
  const combo = resolveCombo(input.requestedModel, input.modality);
  const pairings = collectPairings(input, combo);

  if (pairings.hardError !== null) {
    return { candidates: [], combo, modality: input.modality, hardError: pairings.hardError };
  }

  const requires = mergeFeatures(combo, input.requiredFeatures);
  const maxCost = combo?.maxCostPerMTok ?? null;

  const candidates = pairings.pairs.map((pair) =>
    evaluate(pair, input, requires, maxCost),
  );

  return { candidates, combo, modality: input.modality, hardError: null };
}

/** Combo lookup: exact slug, then the configured default. */
function resolveCombo(requestedModel: string, modality: Modality): Combo | null {
  const bySlug = getComboBySlug(requestedModel);
  if (bySlug !== null && bySlug.enabled) return bySlug;

  // Only fall back to the default policy for the modality it was written for.
  const fallback = getDefaultCombo();
  if (fallback !== null && fallback.modality === modality) return fallback;
  return null;
}

function mergeFeatures(combo: Combo | null, extra: ChatFeature[]): ChatFeature[] {
  const set = new Set<ChatFeature>(extra);
  if (combo !== null) for (const feature of combo.requires) set.add(feature);
  return [...set];
}

interface PairingSet {
  pairs: Pairing[];
  hardError: string | null;
}

function collectPairings(input: ExpandInput, combo: Combo | null): PairingSet {
  const connections = listConnections();
  const byId = new Map(connections.map((c) => [c.id, c]));

  // A combo with an explicit member list pins the search to those members.
  if (combo !== null && combo.members.length > 0) {
    const pairs: Pairing[] = [];
    for (const member of combo.members) {
      if (!member.enabled) continue;
      const connection = byId.get(member.connectionId);
      if (connection === undefined) continue;
      const provider = getProvider(connection.providerId);
      if (provider === null) continue;

      if (member.modelId === '*') {
        for (const model of listModelsFor(provider.id, input.modality)) {
          pairs.push({ connection, provider, model, memberOrder: member.order });
        }
        continue;
      }
      const model = findModel(provider.id, member.modelId);
      if (model === null) continue;
      pairs.push({ connection, provider, model, memberOrder: member.order });
    }
    return { pairs, hardError: null };
  }

  // "provider/model" pins the provider but still spreads across every
  // connection the user holds for it, so a second key still provides failover.
  const slash = input.requestedModel.indexOf('/');
  if (slash > 0 && combo === null) {
    const providerId = input.requestedModel.slice(0, slash);
    const modelId = input.requestedModel.slice(slash + 1);
    const provider = getProvider(providerId);

    if (provider !== null) {
      const model = findModel(providerId, modelId);
      if (model === null) {
        return { pairs: [], hardError: `Model "${modelId}" is not available on ${provider.name}.` };
      }
      const pairs = connections
        .filter((c) => c.providerId === providerId)
        .map((connection) => ({ connection, provider, model, memberOrder: Number.POSITIVE_INFINITY }));

      if (pairs.length === 0) {
        return { pairs: [], hardError: `No connection is configured for ${provider.name}.` };
      }
      return { pairs, hardError: null };
    }
  }

  // A bare model id: every connection that offers it. This is what makes the
  // same `model` string survive a provider outage.
  const bare = input.requestedModel;
  const exact: Pairing[] = [];
  for (const connection of connections) {
    const provider = getProvider(connection.providerId);
    if (provider === null) continue;
    const model = findModel(provider.id, bare);
    if (model === null) continue;
    exact.push({ connection, provider, model, memberOrder: Number.POSITIVE_INFINITY });
  }
  if (exact.length > 0) return { pairs: exact, hardError: null };

  // Nothing matched by name, so this is an "auto"-style request: consider the
  // whole fleet for this modality and let scoring decide.
  const all: Pairing[] = [];
  for (const connection of connections) {
    const provider = getProvider(connection.providerId);
    if (provider === null) continue;
    for (const model of listModelsFor(provider.id, input.modality)) {
      all.push({ connection, provider, model, memberOrder: Number.POSITIVE_INFINITY });
    }
  }
  return { pairs: all, hardError: null };
}

function evaluate(
  pair: Pairing,
  input: ExpandInput,
  requires: ChatFeature[],
  maxCostPerMTok: number | null,
): RouteCandidate {
  const { connection, provider, model } = pair;
  const tier = connection.tierOverride ?? inferTier(provider, model);
  const free = tier === 'free';

  const base: RouteCandidate = {
    connectionId: connection.id,
    providerId: provider.id,
    modelId: model.id,
    tier,
    score: 0,
    factors: [],
    excludedReason: null,
    // What the user is actually billed. A model covered by a provider's free
    // allowance costs nothing, so charging it at list price here would make
    // the whole free-first ladder score against itself.
    projectedCostUsd: free ? 0 : projectCost(model, input.inputTokens, input.maxOutput),
  };

  const exclude = (reason: string): RouteCandidate => ({ ...base, excludedReason: reason });

  if (!connection.enabled) return exclude('Connection is disabled');
  if (model.modality !== input.modality) return exclude(`Model does not serve ${input.modality}`);
  if (provider.requiresKey && !hasCredential(connection.id)) return exclude('No API key configured');

  if (!isAvailable(connection.id)) return exclude('Circuit breaker open — provider is failing');
  if (isLockedOut(connection.id, model.id)) return exclude('Model rate-limited (429 lockout active)');

  for (const feature of requires) {
    if (!model.features.includes(feature)) return exclude(`Model lacks required feature: ${feature}`);
  }

  if (!fitsContext(model, input.inputTokens, input.maxOutput)) {
    return exclude(
      `Context too small — needs ~${input.inputTokens + input.maxOutput} tokens, window is ${model.contextWindow}`,
    );
  }

  // The ceiling is checked against the effective price, so a $0 ceiling means
  // "free tiers only" rather than "nothing at all".
  const effectivePrice = free ? 0 : blendedPrice(model);
  if (maxCostPerMTok !== null && effectivePrice > maxCostPerMTok) {
    return exclude(
      `Costs $${effectivePrice.toFixed(2)}/MTok, over the $${maxCostPerMTok}/MTok ceiling`,
    );
  }

  if (input.freeOnly && tier !== 'free') {
    return exclude('API key is over budget — restricted to free providers');
  }

  if (connection.monthlyBudgetUsd !== null) {
    const spent = monthToDateCostForConnection(connection.id);
    if (spent >= connection.monthlyBudgetUsd) {
      return exclude(
        `Monthly budget exhausted ($${spent.toFixed(2)} of $${connection.monthlyBudgetUsd.toFixed(2)})`,
      );
    }
  }

  return base;
}

/** Member order survives into scoring, so keep it retrievable by candidate. */
export function memberOrderMap(combo: Combo | null): Map<string, number> {
  const map = new Map<string, number>();
  if (combo === null) return map;
  for (const member of combo.members) {
    map.set(`${member.connectionId}:${member.modelId}`, member.order);
  }
  return map;
}
