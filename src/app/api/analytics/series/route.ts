import { usageSeries } from '@/lib/db/repos/usage';
import { guard, handle, intParam, ok, searchParams } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const params = searchParams(req);
    const days = Math.min(365, Math.max(1, intParam(params, 'days', 1)));
    const requested = intParam(params, 'bucket', 0);

    // Buckets are floored to the hour on write, so a finer request cannot be
    // honoured — round up rather than returning a series full of empty gaps.
    const bucketMs = requested >= HOUR ? requested : days <= 2 ? HOUR : DAY;
    const since = Date.now() - days * DAY;

    return ok({ since, bucketMs, series: usageSeries(since, bucketMs) });
  });
}
