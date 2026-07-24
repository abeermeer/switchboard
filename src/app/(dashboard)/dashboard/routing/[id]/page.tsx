import { notFound } from 'next/navigation';
import { getCombo } from '@/lib/db/repos/combos';
import { buildConnectionViews } from '@/lib/router';
import { PolicyEditor } from '@/components/routing/PolicyEditor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PolicyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const combo = getCombo(id);
  if (combo === null) notFound();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">{combo.name}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {combo.description.length > 0
            ? combo.description
            : 'Edit the policy on the left; the trace on the right updates as you go.'}
        </p>
      </div>
      <PolicyEditor combo={combo} connections={buildConnectionViews()} />
    </div>
  );
}
