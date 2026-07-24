import { listApiKeys } from '@/lib/db/repos/apiKeys';
import { listCombos } from '@/lib/db/repos/combos';
import { monthToDateCostForApiKey } from '@/lib/db/repos/usage';
import { KeysView } from '@/components/playground/KeysView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function KeysPage(): React.ReactElement {
  const keys = listApiKeys().map((key) => ({
    ...key,
    spentThisMonthUsd: monthToDateCostForApiKey(key.id),
  }));

  return <KeysView keys={keys} comboSlugs={listCombos().map((c) => c.slug)} />;
}
