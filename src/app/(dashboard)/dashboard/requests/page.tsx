import { listProviders } from '@/lib/providers/registry';
import { RequestList } from '@/components/requests/RequestList';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function RequestsPage(): React.ReactElement {
  const accents = Object.fromEntries(listProviders().map((p) => [p.id, p.accent]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Requests</h1>
        <p className="mt-0.5 text-sm text-muted">
          Every call through the gateway, with the routing decision behind it.
        </p>
      </div>
      <RequestList accents={accents} />
    </div>
  );
}
