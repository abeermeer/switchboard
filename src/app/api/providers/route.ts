import { listProviders } from '@/lib/providers/registry';
import { listConnections } from '@/lib/db/repos/connections';
import { guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const connections = listConnections();
    const byProvider = new Map<string, number>();
    for (const connection of connections) {
      byProvider.set(connection.providerId, (byProvider.get(connection.providerId) ?? 0) + 1);
    }

    return ok({
      items: listProviders().map((provider) => ({
        ...provider,
        connectionCount: byProvider.get(provider.id) ?? 0,
        connected: byProvider.has(provider.id),
      })),
    });
  });
}
