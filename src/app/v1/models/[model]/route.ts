import { listAvailableModels } from '@/lib/router';
import { authenticate, CORS_HEADERS, jsonError, preflight } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ model: string }> },
): Promise<Response> {
  const auth = authenticate(req);
  if (auth.error !== null) return auth.error;

  const { model: requested } = await ctx.params;
  const decoded = decodeURIComponent(requested);
  const entry = listAvailableModels().find((m) => m.id === decoded);

  if (entry === undefined) {
    return jsonError(404, `The model '${decoded}' does not exist.`, 'invalid_request_error', 'model_not_found');
  }

  return Response.json(
    {
      id: entry.id,
      object: 'model',
      created: 0,
      owned_by: entry.ownedBy,
      context_window: entry.model.contextWindow,
      max_output: entry.model.maxOutput,
      input_cost_per_mtok: entry.model.inputCostPerMTok,
      output_cost_per_mtok: entry.model.outputCostPerMTok,
      modality: entry.model.modality,
      features: entry.model.features,
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS(): Response {
  return preflight();
}
