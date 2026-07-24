import { listRequestLogs, pruneLogs, type LogQuery } from '@/lib/db/repos/log';
import { guard, handle, intParam, ok, searchParams } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODALITIES = new Set([
  'chat',
  'embeddings',
  'images',
  'audio.speech',
  'audio.transcription',
  'rerank',
  'moderation',
]);

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const params = searchParams(req);
    const query: LogQuery = {
      limit: Math.min(500, Math.max(1, intParam(params, 'limit', 50))),
      offset: Math.max(0, intParam(params, 'offset', 0)),
    };

    const status = params.get('status');
    if (status === 'success' || status === 'error') query.status = status;

    const connectionId = params.get('connectionId');
    if (connectionId !== null) query.connectionId = connectionId;

    const apiKeyId = params.get('apiKeyId');
    if (apiKeyId !== null) query.apiKeyId = apiKeyId;

    const modality = params.get('modality');
    if (modality !== null && MODALITIES.has(modality)) {
      query.modality = modality as LogQuery['modality'];
    }

    const since = params.get('since');
    if (since !== null) {
      const value = Number.parseInt(since, 10);
      if (Number.isFinite(value)) query.since = value;
    }

    const search = params.get('search');
    if (search !== null && search.length > 0) query.search = search;

    return ok(listRequestLogs(query));
  });
}

export function DELETE(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const olderThanDays = intParam(searchParams(req), 'olderThanDays', 0);
    const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 86_400_000 : Date.now();

    return ok({ deleted: pruneLogs(cutoff) });
  });
}
