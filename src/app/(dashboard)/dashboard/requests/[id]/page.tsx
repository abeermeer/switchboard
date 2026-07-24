import { notFound } from 'next/navigation';
import { getRequestLog } from '@/lib/db/repos/log';
import { listProviders } from '@/lib/providers/registry';
import { RequestDetail } from '@/components/requests/RequestDetail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const detail = getRequestLog(id);
  if (detail === null) notFound();

  const accents = Object.fromEntries(listProviders().map((p) => [p.id, p.accent]));
  return <RequestDetail detail={detail} accents={accents} />;
}
