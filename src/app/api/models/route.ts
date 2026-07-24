import type { CostTier } from '@/types/core';
import { listConnections } from '@/lib/db/repos/connections';
import { hasCredential } from '@/lib/db/repos/credentials';
import { isLockedOut } from '@/lib/db/repos/health';
import { snapshotAll } from '@/lib/resilience/breaker';
import { getProvider, inferTier } from '@/lib/providers/registry';
import { guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Offering {
  connectionId: string;
  label: string;
  providerId: string;
  providerName: string;
  accent: string;
  tier: CostTier;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  status: string;
  p50LatencyMs: number | null;
  lockedOut: boolean;
  hasCredential: boolean;
}

/**
 * Every model across every configured provider, grouped so the redundancy is
 * visible: a model offered by three providers is a model that survives two
 * outages, and the price spread across those three is usually large.
 */
export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const health = snapshotAll();
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        modality: string;
        features: string[];
        contextWindow: number;
        maxOutput: number;
        offerings: Offering[];
      }
    >();

    for (const connection of listConnections()) {
      const provider = getProvider(connection.providerId);
      if (provider === null) continue;

      const credentialed = !provider.requiresKey || hasCredential(connection.id);
      const snapshot = health[connection.id] ?? null;

      for (const model of provider.models) {
        let entry = grouped.get(model.id);
        if (entry === undefined) {
          entry = {
            id: model.id,
            name: model.name,
            modality: model.modality,
            features: model.features,
            contextWindow: model.contextWindow,
            maxOutput: model.maxOutput,
            offerings: [],
          };
          grouped.set(model.id, entry);
        }

        entry.offerings.push({
          connectionId: connection.id,
          label: connection.label,
          providerId: provider.id,
          providerName: provider.name,
          accent: provider.accent,
          tier: connection.tierOverride ?? inferTier(provider, model),
          inputCostPerMTok: model.inputCostPerMTok,
          outputCostPerMTok: model.outputCostPerMTok,
          status: !connection.enabled
            ? 'disabled'
            : !credentialed
              ? 'unconfigured'
              : (snapshot?.status ?? 'unconfigured'),
          p50LatencyMs: snapshot?.p50LatencyMs ?? null,
          lockedOut: isLockedOut(connection.id, model.id),
          hasCredential: credentialed,
        });
      }
    }

    const items = [...grouped.values()].map((entry) => {
      const blended = entry.offerings.map(
        (o) => o.inputCostPerMTok * 0.75 + o.outputCostPerMTok * 0.25,
      );
      const cheapest = Math.min(...blended);
      const cheapestIndex = blended.indexOf(cheapest);

      return {
        ...entry,
        providerCount: entry.offerings.length,
        cheapestConnectionId: entry.offerings[cheapestIndex]?.connectionId ?? null,
        minInputCostPerMTok: Math.min(...entry.offerings.map((o) => o.inputCostPerMTok)),
        minOutputCostPerMTok: Math.min(...entry.offerings.map((o) => o.outputCostPerMTok)),
        bestTier: entry.offerings.some((o) => o.tier === 'free')
          ? 'free'
          : (entry.offerings[cheapestIndex]?.tier ?? 'standard'),
        offerings: entry.offerings.sort(
          (a, b) =>
            a.inputCostPerMTok * 0.75 + a.outputCostPerMTok * 0.25 -
            (b.inputCostPerMTok * 0.75 + b.outputCostPerMTok * 0.25),
        ),
      };
    });

    items.sort((a, b) => b.providerCount - a.providerCount || a.id.localeCompare(b.id));

    return ok({ items });
  });
}
