import type { CostTier } from '@/types/core';
import { listConnections } from '@/lib/db/repos/connections';
import { hasCredential } from '@/lib/db/repos/credentials';
import { isLockedOut } from '@/lib/db/repos/health';
import { snapshotAll } from '@/lib/resilience/breaker';
import { getProvider, inferTier } from '@/lib/providers/registry';
import { EmptyState } from '@/components/ui';
import { ModelsTable, type ModelGroup } from '@/components/analytics/ModelsTable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Offering {
  connectionId: string;
  label: string;
  providerName: string;
  accent: string;
  tier: CostTier;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  status: string;
  p50LatencyMs: number | null;
  lockedOut: boolean;
}

export default function ModelsPage(): React.ReactElement {
  const connections = listConnections();
  const health = snapshotAll();

  const grouped = new Map<string, Omit<ModelGroup, 'providerCount' | 'cheapestConnectionId' | 'minInputCostPerMTok' | 'minOutputCostPerMTok' | 'bestTier'> & { offerings: Offering[] }>();

  for (const connection of connections) {
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
      });
    }
  }

  const models: ModelGroup[] = [...grouped.values()].map((entry) => {
    const blended = entry.offerings.map((o) => o.inputCostPerMTok * 0.75 + o.outputCostPerMTok * 0.25);
    const cheapestIndex = blended.indexOf(Math.min(...blended));
    const sorted = [...entry.offerings].sort(
      (a, b) =>
        a.inputCostPerMTok * 0.75 + a.outputCostPerMTok * 0.25 -
        (b.inputCostPerMTok * 0.75 + b.outputCostPerMTok * 0.25),
    );

    return {
      ...entry,
      offerings: sorted,
      providerCount: entry.offerings.length,
      cheapestConnectionId: entry.offerings[cheapestIndex]?.connectionId ?? null,
      minInputCostPerMTok: Math.min(...entry.offerings.map((o) => o.inputCostPerMTok)),
      minOutputCostPerMTok: Math.min(...entry.offerings.map((o) => o.outputCostPerMTok)),
      bestTier: entry.offerings.some((o) => o.tier === 'free') ? 'free' : (sorted[0]?.tier ?? 'standard'),
    };
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Models</h1>
        <p className="mt-0.5 text-sm text-muted">
          Every model your connected providers can serve. A model listed under several providers is
          one that survives an outage.
        </p>
      </div>

      {models.length === 0 ? (
        <EmptyState
          title="No models yet"
          description="Connect a provider and its catalog appears here with live pricing and health."
        />
      ) : (
        <ModelsTable models={models} />
      )}
    </div>
  );
}
