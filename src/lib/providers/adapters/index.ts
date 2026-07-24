import type { ProviderAdapter, ProviderKind } from '@/types/core';
import { anthropicAdapter } from './anthropic';
import { cohereAdapter } from './cohere';
import { googleAdapter } from './google';
import { openaiCompatibleAdapter } from './openaiCompatible';

export const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  'openai-compatible': openaiCompatibleAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  cohere: cohereAdapter,
};

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return ADAPTERS[kind];
}

export { anthropicAdapter, cohereAdapter, googleAdapter, openaiCompatibleAdapter };
