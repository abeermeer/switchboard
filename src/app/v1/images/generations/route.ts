import { handleModality } from '@/lib/api/handler';
import { preflight } from '@/lib/api/respond';
import { imagesSchema } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handleModality(req, 'images', imagesSchema);
}

export function OPTIONS(): Response {
  return preflight();
}
