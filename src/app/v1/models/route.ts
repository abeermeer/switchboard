import { listAvailableModels } from '@/lib/router';
import { authenticate, CORS_HEADERS, preflight } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Response {
  const auth = authenticate(req);
  if (auth.error !== null) return auth.error;

  const models = listAvailableModels();

  return Response.json(
    {
      object: 'list',
      data: models.map((entry) => ({
        id: entry.id,
        object: 'model',
        created: 0,
        owned_by: entry.ownedBy,
        // Non-standard, but harmless to clients and genuinely useful: these are
        // what let a caller choose a model without a second round trip.
        context_window: entry.model.contextWindow,
        max_output: entry.model.maxOutput,
        input_cost_per_mtok: entry.model.inputCostPerMTok,
        output_cost_per_mtok: entry.model.outputCostPerMTok,
        modality: entry.model.modality,
        features: entry.model.features,
      })),
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS(): Response {
  return preflight();
}
