import { z } from 'zod';

/**
 * Validation is deliberately shallow. Clients constantly send provider-specific
 * extras (reasoning_effort, safety_settings, cache hints), and rejecting an
 * unknown field here would break a working integration for no benefit — the
 * provider is the authority on its own parameters. Only what routing actually
 * reads is enforced; everything else passes through untouched.
 */

const passthrough = z.looseObject({});

export const chatSchema = z
  .looseObject({
    model: z.string().min(1, 'model is required'),
    messages: z.array(passthrough).min(1, 'messages must contain at least one message'),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
  });

export const completionSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  prompt: z.union([z.string(), z.array(z.string())]),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const embeddingsSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  input: z.union([z.string(), z.array(z.string()), z.array(z.number()), z.array(z.array(z.number()))]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
});

export const imagesSchema = z.looseObject({
  model: z.string().optional(),
  prompt: z.string().min(1, 'prompt is required'),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

export const speechSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  input: z.string().min(1, 'input is required'),
  voice: z.string().optional(),
  response_format: z.string().optional(),
  speed: z.number().optional(),
});

export const rerankSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  query: z.string().min(1, 'query is required'),
  documents: z.array(z.union([z.string(), passthrough])).min(1),
  top_n: z.number().int().positive().optional(),
});

export const moderationSchema = z.looseObject({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
});

/** First zod issue, phrased the way the OpenAI API phrases its own errors. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Invalid request body.';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}
