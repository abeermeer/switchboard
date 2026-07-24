import { notFound } from 'next/navigation';
import { buildConnectionViews } from '@/lib/router';
import { listModelsFor } from '@/lib/providers/registry';
import { listLockouts } from '@/lib/db/repos/health';
import { monthToDateCostForConnection } from '@/lib/db/repos/usage';
import { ConnectionDetail } from '@/components/providers/ConnectionDetail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ConnectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const connection = buildConnectionViews().find((view) => view.id === id);
  if (connection === undefined) notFound();

  return (
    <ConnectionDetail
      connection={connection}
      models={listModelsFor(connection.providerId)}
      lockouts={listLockouts().filter((lock) => lock.connectionId === id)}
      monthToDateUsd={monthToDateCostForConnection(id)}
    />
  );
}
