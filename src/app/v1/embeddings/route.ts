import { handleModality } from '@/lib/api/handler';
import { preflight } from '@/lib/api/respond';
import { embeddingsSchema } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleModality(req, 'embeddings', embeddingsSchema);
}

export function OPTIONS(req: Request): Response {
  return preflight(req);
}
