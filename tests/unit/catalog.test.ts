import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '@/lib/providers/catalog';

describe('providers/catalog retiredModels', () => {
  // findModel follows one hop and returns null on a dangling successor, so a
  // typo here would quietly turn a retired id back into an unknown one.
  it('points every retired id at a model the provider still lists', () => {
    for (const provider of PROVIDER_CATALOG) {
      const live = new Set(provider.models.map((m) => m.id.toLowerCase()));
      for (const [retired, successor] of Object.entries(provider.retiredModels ?? {})) {
        expect(retired, `${provider.id}: retired id must be lower-case`).toBe(retired.toLowerCase());
        expect(live.has(retired), `${provider.id}: ${retired} is retired but still listed`).toBe(false);
        expect(live.has(successor.toLowerCase()), `${provider.id}: ${retired} -> ${successor}`).toBe(true);
      }
    }
  });

  it('no longer lists Claude Sonnet 4.5 anywhere', () => {
    const ids = PROVIDER_CATALOG.flatMap((p) => p.models.map((m) => m.id));
    expect(ids.filter((id) => /sonnet-4[-.]5/.test(id))).toEqual([]);
  });
});
