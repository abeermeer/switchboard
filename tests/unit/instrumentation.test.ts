import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register } from '@/instrumentation';
import { listCombos } from '@/lib/db/repos/combos';
import { stopHealthScheduler } from '@/lib/health/probe';
import { dropDb, freshDb } from '../helpers/db';

const scheduler = () =>
  (globalThis as { __switchboardHealthScheduler?: { timer: unknown; intervalSec: number } })
    .__switchboardHealthScheduler;

describe('server startup (instrumentation register)', () => {
  let dir: string;
  const saved = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    dir = freshDb();
    process.env.NEXT_RUNTIME = 'nodejs';
  });

  afterEach(() => {
    stopHealthScheduler();
    if (saved === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = saved;
    dropDb(dir);
  });

  it('seeds the starter policies without any dashboard page being rendered', async () => {
    // Only some dashboard pages seeded them, so a CLI- or API-only install had
    // no free-only, and a request for it went to paid providers.
    expect(listCombos()).toHaveLength(0);

    await register();

    expect(listCombos().map((c) => c.slug).sort()).toEqual(['auto', 'fast', 'free-only', 'quality']);
  });

  it('starts the health loop, which nothing ever started before', async () => {
    // Without it, log retention, latency pruning and the probes never ran.
    await register();

    expect(scheduler()?.timer).not.toBeNull();
    expect(scheduler()?.intervalSec).toBe(120);
  });

  it('does nothing outside the Node runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    await register();

    expect(listCombos()).toHaveLength(0);
  });
});
