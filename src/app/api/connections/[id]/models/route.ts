import { getConnection } from '@/lib/db/repos/connections';
import { getCredential } from '@/lib/db/repos/credentials';
import { listDiscoveredModels, saveDiscoveredModels } from '@/lib/db/repos/models';
import { getProvider, listModelsFor, resolveBaseUrl } from '@/lib/providers/registry';
import { isLockedOut } from '@/lib/db/repos/health';
import { fail, guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const connection = getConnection(id);
    if (connection === null) return fail(404, 'Connection not found.');

    const provider = getProvider(connection.providerId);
    if (provider === null) return fail(404, 'Provider not found.');

    return ok({
      catalog: listModelsFor(provider.id).map((model) => ({
        ...model,
        lockedOut: isLockedOut(id, model.id),
      })),
      discovered: listDiscoveredModels(id),
    });
  });
}

/**
 * Refreshes the model list from the provider's live endpoint. The catalog is a
 * curated baseline with pricing; discovery catches models a provider added
 * after this build shipped, so a new release is not needed to use them.
 */
export function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const connection = getConnection(id);
    if (connection === null) return fail(404, 'Connection not found.');

    const provider = getProvider(connection.providerId);
    if (provider === null) return fail(404, 'Provider not found.');
    if (provider.modelsPath === undefined) {
      return fail(400, `${provider.name} does not publish a model list endpoint.`);
    }

    const credential = provider.requiresKey ? getCredential(id) : null;
    if (provider.requiresKey && credential === null) {
      return fail(400, 'This connection has no API key configured.');
    }

    const url = new URL(resolveBaseUrl(connection, provider) + provider.modelsPath);
    const headers: Record<string, string> = { accept: 'application/json', ...provider.extraHeaders };

    if (credential !== null) {
      switch (provider.authScheme) {
        case 'bearer':
          headers['authorization'] = `Bearer ${credential}`;
          break;
        case 'header':
          headers[provider.authHeaderName ?? 'x-api-key'] = credential;
          break;
        case 'query':
          url.searchParams.set(provider.authQueryParam ?? 'key', credential);
          break;
        case 'none':
          break;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        return fail(502, `${provider.name} returned ${response.status} for its model list.`);
      }

      const payload: unknown = await response.json();
      const models = extractModels(payload);
      if (models.length === 0) {
        return fail(502, 'The provider returned no recognisable models.');
      }

      saveDiscoveredModels(id, models);
      return ok({ discovered: models.length, models: listDiscoveredModels(id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(502, `Could not reach ${provider.name}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Providers disagree on the envelope; these are the shapes seen in practice. */
function extractModels(payload: unknown): Array<{ id: string; raw: unknown }> {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? ((payload as Record<string, unknown>)['data'] ??
         (payload as Record<string, unknown>)['models'])
      : null;

  if (!Array.isArray(rows)) return [];

  const out: Array<{ id: string; raw: unknown }> = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      out.push({ id: row, raw: row });
      continue;
    }
    if (row === null || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = record['id'] ?? record['name'] ?? record['model'];
    if (typeof id === 'string' && id.length > 0) out.push({ id, raw: row });
  }
  return out;
}
