import type { Client } from "./config.ts";
import type { Db } from "./db.ts";

export const MAX_AGE_MS = 36 * 3600 * 1000;

// Of the enabled and registered sources of the enabled clients, those whose last successful
// run is older than 36 hours. If it has never succeeded, the time of the first migration (install) is the
// reference point: a fresh install is healthy for 36 hours, but a dead scheduler shows up afterwards.
// With an empty registry (or no sources) there is nothing to check, so it is healthy.
export function staleSources(db: Db, clients: Client[], registered: string[], now = Date.now()) {
  const installed = db.prepare("SELECT min(applied_at) FROM schema_migrations").pluck().get() as string;
  const last = db
    .prepare("SELECT max(finished_at) FROM runs WHERE client_id = ? AND source = ? AND status = 'ok'")
    .pluck();
  const stale: { client: string; source: string; last: string | null }[] = [];
  for (const c of clients.filter((c) => c.enabled)) {
    for (const [source, cfg] of Object.entries(c.sources)) {
      if (!cfg.enabled || !registered.includes(source)) continue;
      const ok = last.get(c.id, source) as string | null;
      if (now - Date.parse(ok ?? installed) > MAX_AGE_MS) stale.push({ client: c.id, source, last: ok });
    }
  }
  return stale;
}
