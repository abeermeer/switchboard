import { listCombos } from '@/lib/db/repos/combos';
import { listAvailableModels } from '@/lib/router';
import { getProvider } from '@/lib/providers/registry';
import { EmptyState } from '@/components/ui';
import { Playground } from '@/components/playground/Playground';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function PlaygroundPage(): React.ReactElement {
  const models = listAvailableModels('chat').map((entry) => ({
    id: entry.id,
    label: entry.id,
    accent: getProvider(entry.ownedBy)?.accent ?? '#888888',
    free: entry.model.inputCostPerMTok === 0 && entry.model.outputCostPerMTok === 0,
  }));

  const combos = listCombos()
    .filter((combo) => combo.enabled && combo.modality === 'chat')
    .map((combo) => ({ slug: combo.slug, name: combo.name }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Playground</h1>
        <p className="mt-0.5 text-sm text-muted">
          Race models against each other on the same prompt, with live cost and latency.
        </p>
      </div>

      {models.length === 0 ? (
        <EmptyState
          title="No chat models available"
          description="Connect a provider with a chat model and it appears here immediately."
        />
      ) : (
        <Playground models={models} combos={combos} />
      )}
    </div>
  );
}
