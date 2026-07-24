import { z } from 'zod';
import { getCombo } from '@/lib/db/repos/combos';
import { expandCandidates, scoreCandidates, STRATEGY_WEIGHTS } from '@/lib/router';
import { getProvider } from '@/lib/providers/registry';
import { estimateInputTokens } from '@/lib/usage/cost';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  prompt: z.string().max(200_000).optional(),
  /** Overrides the estimate when the user wants to test a large-context case. */
  inputTokens: z.number().int().min(0).max(10_000_000).optional(),
  maxOutput: z.number().int().min(1).max(200_000).optional(),
  requiredFeatures: z
    .array(z.enum(['tools', 'vision', 'json_mode', 'reasoning', 'streaming', 'prefill']))
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Scores a policy without sending anything upstream.
 *
 * This is the dry run behind the routing page: the user drags a member or moves
 * the cost ceiling and immediately sees the ranking reshuffle, including what
 * got excluded and why. It runs the exact same expand + score path a live
 * request takes, so what it shows is what would actually happen.
 */
export function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const combo = getCombo(id);
    if (combo === null) return fail(404, 'Policy not found.');

    const parsed = await readBody(req, bodySchema);
    if ('error' in parsed) return parsed.error;

    const prompt = parsed.data.prompt ?? '';
    const inputTokens =
      parsed.data.inputTokens ??
      estimateInputTokens({ messages: [{ role: 'user', content: prompt }] });
    const maxOutput = parsed.data.maxOutput ?? 1024;

    const expanded = expandCandidates({
      modality: combo.modality,
      requestedModel: combo.slug,
      inputTokens,
      maxOutput,
      requiredFeatures: parsed.data.requiredFeatures ?? [],
      freeOnly: false,
      apiKey: null,
    });

    const ranked = scoreCandidates(expanded.candidates, combo.strategy, {
      strategy: combo.strategy,
      combo,
      rotation: 0,
    });

    const eligible = ranked.filter((c) => c.excludedReason === null);
    const excluded = ranked.filter((c) => c.excludedReason !== null);

    // Provider names and accents are attached here so the UI can render the
    // trace without a second request per candidate.
    const decorate = (c: (typeof ranked)[number]) => {
      const provider = getProvider(c.providerId);
      return {
        ...c,
        providerName: provider?.name ?? c.providerId,
        accent: provider?.accent ?? '#888888',
      };
    };

    return ok({
      comboId: combo.id,
      strategy: combo.strategy,
      weights: STRATEGY_WEIGHTS[combo.strategy],
      inputTokens,
      maxOutput,
      winner: eligible.length > 0 ? decorate(eligible[0]!) : null,
      candidates: eligible.map(decorate),
      excluded: excluded.map(decorate),
      hardError: expanded.hardError,
    });
  });
}
