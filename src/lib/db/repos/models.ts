import { getDb, parseJson, transact } from '@/lib/db/client';
import { asRows, num, safeStringify, str } from '@/lib/db/rows';

/**
 * Mirrors a provider's live /models response. The set is replaced wholesale on
 * every discovery so a model the provider retired disappears here too, instead
 * of lingering as a routing candidate that always 404s.
 */
export function saveDiscoveredModels(
  connectionId: string,
  models: Array<{ id: string; raw: unknown }>,
): void {
  const now = Date.now();

  transact((handle) => {
    handle.prepare('DELETE FROM discovered_models WHERE connection_id = ?').run(connectionId);

    const stmt = handle.prepare(
      `INSERT OR REPLACE INTO discovered_models
         (connection_id, model_id, raw_json, discovered_at)
       VALUES (?, ?, ?, ?)`,
    );

    for (const model of models) {
      const modelId = model.id.trim();
      if (!modelId) continue;
      stmt.run(connectionId, modelId, safeStringify(model.raw) ?? 'null', now);
    }
  });
}

export function listDiscoveredModels(
  connectionId: string,
): Array<{ id: string; raw: unknown; discoveredAt: number }> {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT model_id, raw_json, discovered_at
           FROM discovered_models
          WHERE connection_id = ?
          ORDER BY model_id ASC`,
      )
      .all(connectionId),
  );

  return rows.map((row) => ({
    id: str(row.model_id),
    raw: parseJson<unknown>(row.raw_json, null),
    discoveredAt: num(row.discovered_at, 0),
  }));
}

export function clearDiscoveredModels(connectionId: string): void {
  getDb().prepare('DELETE FROM discovered_models WHERE connection_id = ?').run(connectionId);
}
