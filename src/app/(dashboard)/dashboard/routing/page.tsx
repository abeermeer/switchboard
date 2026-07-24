import { ensureSeedCombos, listCombos } from '@/lib/db/repos/combos';
import { PolicyList } from '@/components/routing/PolicyList';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function RoutingPage(): React.ReactElement {
  ensureSeedCombos();
  return <PolicyList combos={listCombos()} />;
}
