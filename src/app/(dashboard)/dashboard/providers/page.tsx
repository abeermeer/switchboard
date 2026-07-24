import { buildConnectionViews } from '@/lib/router';
import { listProviders } from '@/lib/providers/registry';
import { ProviderGrid } from '@/components/providers/ProviderGrid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function ProvidersPage(): React.ReactElement {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Providers</h1>
        <p className="mt-0.5 text-sm text-muted">
          Connect a provider once and every routing policy can reach it.
        </p>
      </div>
      <ProviderGrid connections={buildConnectionViews()} providers={listProviders()} />
    </div>
  );
}
