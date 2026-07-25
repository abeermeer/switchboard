import type { ChatFeature } from '@/types/core';
import { handleModality } from '@/lib/api/handler';
import { preflight } from '@/lib/api/respond';
import { chatSchema } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the request implies about the model it needs. A body carrying tool
 * definitions cannot be routed to a model without tool support, so these become
 * hard eligibility filters rather than preferences.
 */
function deriveFeatures(body: Record<string, unknown>): ChatFeature[] {
  const features: ChatFeature[] = [];

  if (Array.isArray(body['tools']) && body['tools'].length > 0) features.push('tools');
  if (body['functions'] !== undefined) features.push('tools');
  if (body['stream'] === true) features.push('streaming');

  const format = body['response_format'];
  if (format !== null && typeof format === 'object') {
    const type = (format as Record<string, unknown>)['type'];
    if (type === 'json_object' || type === 'json_schema') features.push('json_mode');
  }

  if (body['reasoning_effort'] !== undefined || body['thinking'] !== undefined) {
    features.push('reasoning');
  }

  const messages = body['messages'];
  if (Array.isArray(messages)) {
    const hasImage = messages.some((message) => {
      if (message === null || typeof message !== 'object') return false;
      const content = (message as Record<string, unknown>)['content'];
      if (!Array.isArray(content)) return false;
      return content.some((part) => {
        if (part === null || typeof part !== 'object') return false;
        const type = (part as Record<string, unknown>)['type'];
        return type === 'image_url' || type === 'image';
      });
    });
    if (hasImage) features.push('vision');
  }

  return features;
}

export async function POST(req: Request): Promise<Response> {
  return handleModality(req, 'chat', chatSchema, { deriveFeatures });
}

export function OPTIONS(req: Request): Response {
  return preflight(req);
}
