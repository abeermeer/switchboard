import { statSync } from 'node:fs';
import { dataDir, dbPath } from '@/lib/db/client';
import { getSettings } from '@/lib/db/repos/settings';
import { ensureSeedCombos, listCombos } from '@/lib/db/repos/combos';
import { SettingsView } from '@/components/playground/SettingsView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function SettingsPage(): React.ReactElement {
  ensureSeedCombos();

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath()).size;
  } catch {
    // The file only exists after the first write.
  }

  return (
    <SettingsView
      settings={getSettings()}
      comboSlugs={listCombos().map((c) => c.slug)}
      dataDir={dataDir()}
      dbSizeBytes={dbSizeBytes}
    />
  );
}
