import type {
  CatalogModel,
  Connection,
  CostTier,
  Modality,
  ProviderAdapter,
  ProviderCatalogEntry,
  ProviderKind,
} from '@/types/core';
import { PROVIDER_CATALOG } from './catalog';
import { adapterFor } from './adapters';
import { effectiveBaseUrl } from './adapters/shared';

const BY_ID = new Map<string, ProviderCatalogEntry>(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
);

const MODELS_BY_PROVIDER = new Map<string, Map<string, CatalogModel>>(
  PROVIDER_CATALOG.map((provider) => [
    provider.id,
    new Map(provider.models.map((model) => [model.id.toLowerCase(), model])),
  ]),
);

export function listProviders(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG;
}

export function getProvider(providerId: string): ProviderCatalogEntry | null {
  return BY_ID.get(providerId) ?? null;
}

export function findModel(providerId: string, modelId: string): CatalogModel | null {
  return MODELS_BY_PROVIDER.get(providerId)?.get(modelId.trim().toLowerCase()) ?? null;
}

export function listModelsFor(providerId: string, modality?: Modality): CatalogModel[] {
  const provider = BY_ID.get(providerId);
  if (provider === undefined) return [];
  if (modality === undefined) return provider.models;
  return provider.models.filter((model) => model.modality === modality);
}

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  return adapterFor(kind);
}

export function resolveBaseUrl(conn: Connection, provider: ProviderCatalogEntry): string {
  return effectiveBaseUrl(conn, provider);
}

/**
 * Requests are input-heavy far more often than output-heavy, so the tier ladder
 * scores a 3:1 blend rather than a flat average. Without that, a model with
 * cheap input and expensive output ranks alongside one that is expensive on both.
 */
function blendedCost(model: CatalogModel): number {
  return (model.inputCostPerMTok * 3 + model.outputCostPerMTok) / 4;
}

function tierForCost(blended: number): CostTier {
  if (blended <= 0) return 'free';
  if (blended <= 0.5) return 'cheap';
  if (blended <= 5) return 'standard';
  return 'premium';
}

/**
 * Blended price below which a provider's published free tier is assumed to
 * cover the model.
 *
 * Free tiers are advertised against a provider's smaller models — Groq says
 * "small models", Google says "Flash" — never the flagship. No provider
 * publishes a machine-readable list of which models qualify, so this threshold
 * stands in for it: it captures the 8B-class and Flash-class models the free
 * tiers actually cover, and leaves frontier models priced as what they are.
 */
const FREE_TIER_COVERS_UP_TO = 1.0;

/** What a request through this connection actually costs the user right now. */
export function isCoveredByFreeTier(
  provider: ProviderCatalogEntry,
  model: CatalogModel,
): boolean {
  if (model.inputCostPerMTok === 0 && model.outputCostPerMTok === 0) return true;
  if (provider.freeTier === null) return false;
  return blendedCost(model) <= FREE_TIER_COVERS_UP_TO;
}

export function inferTier(
  provider: ProviderCatalogEntry,
  model: CatalogModel | null,
): CostTier {
  if (model !== null) {
    // A provider with a published free allowance genuinely serves these at $0
    // until the quota runs out, which is the entire premise of free-first
    // routing. Pricing them off the list rate would rank a real free tier
    // level with a paid one.
    if (isCoveredByFreeTier(provider, model)) return 'free';
    return tierForCost(blendedCost(model));
  }

  // No specific model in hand: a provider with a real free tier is the whole
  // point of the free-first ladder, so it leads regardless of list prices.
  if (provider.freeTier !== null) return 'free';
  if (provider.models.length === 0) return 'standard';

  let cheapest = Number.POSITIVE_INFINITY;
  for (const candidate of provider.models) {
    if (candidate.modality !== 'chat') continue;
    cheapest = Math.min(cheapest, blendedCost(candidate));
  }
  if (!Number.isFinite(cheapest)) {
    for (const candidate of provider.models) cheapest = Math.min(cheapest, blendedCost(candidate));
  }
  return Number.isFinite(cheapest) ? tierForCost(cheapest) : 'standard';
}

/** True when the provider publishes at least one model for this modality. */
export function supportsModality(provider: ProviderCatalogEntry, modality: Modality): boolean {
  return (
    provider.modalities.includes(modality) &&
    provider.models.some((model) => model.modality === modality)
  );
}

/** Cheapest model of a modality — the router's fallback when a member says '*'. */
export function defaultModelFor(
  providerId: string,
  modality: Modality = 'chat',
): CatalogModel | null {
  const models = listModelsFor(providerId, modality);
  let best: CatalogModel | null = null;
  for (const model of models) {
    if (best === null || blendedCost(model) < blendedCost(best)) best = model;
  }
  return best;
}

/** Every provider that lists a model whose id matches, for alias resolution. */
export function findProvidersWithModel(modelId: string): Array<{
  provider: ProviderCatalogEntry;
  model: CatalogModel;
}> {
  const needle = modelId.trim().toLowerCase();
  const hits: Array<{ provider: ProviderCatalogEntry; model: CatalogModel }> = [];
  for (const provider of PROVIDER_CATALOG) {
    const model = MODELS_BY_PROVIDER.get(provider.id)?.get(needle);
    if (model !== undefined) hits.push({ provider, model });
  }
  return hits;
}

export { PROVIDER_CATALOG };
