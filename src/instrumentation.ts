/**
 * Runs once when the server starts (Next calls `register` before serving).
 *
 * Two things that had nothing to start them:
 *
 * - The background health loop. `startHealthScheduler` existed from the first
 *   commit, but nothing ever called it, so in a running install the probes,
 *   the latency-sample pruning and the log retention sweep never ran. A 30-day
 *   retention setting meant every prompt was kept forever.
 * - The four starter policies. They were seeded only when certain dashboard
 *   pages rendered, so an install driven from the CLI or the API alone had no
 *   `free-only`. A request for it was then routed as an unknown model, with no
 *   cost ceiling, to paid providers.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build` evaluates this module too; it must not open a database there.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { ensureSeedCombos } = await import('@/lib/db/repos/combos');
  const { startHealthScheduler } = await import('@/lib/health/probe');
  const { logger } = await import('@/lib/logger');

  try {
    ensureSeedCombos();
  } catch (err) {
    logger.error('could not seed the default routing policies', { err });
  }
  try {
    startHealthScheduler();
  } catch (err) {
    logger.error('could not start the health scheduler', { err });
  }
}
