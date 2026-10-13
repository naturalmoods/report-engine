import type { Client } from "../core/config.ts";
import type { Db } from "../core/db.ts";
import { staleSources } from "../core/health.ts";
import { previewUrl } from "../delivery/flow.ts";
import { registry } from "../sources/registry.ts";
import { notify } from "./telegram.ts";

type Deps = Parameters<typeof notify>[1];
export type Failure = { client_id: string; source: string; error: string };

const first = (s: string) => s.split("\n")[0].slice(0, 200);

// At command start: the highest id of runs so far. Only rows newer than this are the command's own runs.
// ponytail: an error of a concurrent other command (e.g. uptime during a long collect) can get in too; separate run-id tracking is needed if this bothers.
export const baseline = (db: Db): number => db.prepare("SELECT coalesce(max(id), 0) FROM runs").pluck().get() as number;

export const failuresSince = (db: Db, since: number): Failure[] =>
  db.prepare("SELECT client_id, source, coalesce(error, '') AS error FROM runs WHERE id > ? AND status = 'error' ORDER BY id").all(since) as Failure[];

// One aggregated message, not one per client: client, source, first line of the error.
export const failureMessage = (command: string, fs: Failure[]): string =>
  `report-engine, ${command}: ${fs.length} hibás futás\n${fs.map((f) => `- ${f.client_id} / ${f.source}: ${first(f.error)}`).join("\n")}`;

// A repeating error (uptime writes the same network error every 5 minutes) alerts at most hourly:
// the same command+client+source+error-first-line is not sent again within an hour. The state is in source_state
// (client_id='_', source='alerts'); recorded only after a successful send, so a Telegram outage does not swallow an alert.
export async function alertFailures(db: Db, command: string, since: number, deps?: Deps & { now?: number }): Promise<void> {
  const now = deps?.now ?? Date.now();
  db.prepare("DELETE FROM source_state WHERE client_id = '_' AND source = 'alerts' AND value < ?").run(new Date(now - 7 * 86_400_000).toISOString());
  const key = (f: Failure) => `${command}|${f.client_id}|${f.source}|${first(f.error)}`;
  const last = db.prepare("SELECT value FROM source_state WHERE client_id = '_' AND source = 'alerts' AND key = ?").pluck();
  const fresh = failuresSince(db, since).filter((f) => {
    const t = last.get(key(f)) as string | undefined;
    return !t || now - Date.parse(t) >= 3600_000;
  });
  if (!fresh.length || !(await notify(failureMessage(command, fresh), deps))) return;
  const set = db.prepare("INSERT INTO source_state (client_id, source, key, value) VALUES ('_', 'alerts', ?, ?) ON CONFLICT (client_id, source, key) DO UPDATE SET value = excluded.value");
  for (const f of fresh) set.run(key(f), new Date(now).toISOString());
}

// Dead-man: an enabled source has not run successfully for 36 hours (core/health.ts, same as status --health).
export const staleMessage = (stale: { client: string; source: string; last: string | null }[]): string =>
  `report-engine: elavult forrás, 36 órája nem futott sikeresen\n${stale.map((s) => `- ${s.client} / ${s.source} (utolsó siker: ${s.last ?? "soha"})`).join("\n")}`;

export async function alertStale(db: Db, clients: Client[], deps?: Deps): Promise<void> {
  const stale = staleSources(db, clients, registry.map((s) => s.id));
  if (stale.length) await notify(staleMessage(stale), deps);
}

// Uptime downtime and recovery (events after the pre-round events.id): once per state change, so no throttle is needed.
export async function alertDowntime(db: Db, sinceEventId: number, deps?: Deps): Promise<void> {
  const ev = db
    .prepare("SELECT client_id, title FROM events WHERE id > ? AND source = 'uptime' AND type IN ('downtime_start', 'downtime_end') ORDER BY id")
    .all(sinceEventId) as { client_id: string; title: string }[];
  if (ev.length) await notify(`report-engine, uptime\n${ev.map((e) => `- ${e.client_id}: ${e.title}`).join("\n")}`, deps);
}

export const maxEventId = (db: Db): number => db.prepare("SELECT coalesce(max(id), 0) FROM events").pluck().get() as number;

// After the report: drafts awaiting approval per client with the preview link (one message).
export function draftsMessage(db: Db, clients: Client[], month: string, baseUrl: string | undefined): string | undefined {
  const drafts = clients.filter((c) => db.prepare("SELECT status FROM reports WHERE client_id = ? AND month = ?").pluck().get(c.id, month) === "draft");
  if (!drafts.length) return undefined;
  const line = (c: Client) => `- ${c.name}: ${(baseUrl && previewUrl(db, baseUrl, c.id, month)) || "nincs előnézeti link"}  (jóváhagyás: approve ${c.id} ${month})`;
  return `report-engine: ${month} draftok jóváhagyásra várnak\n${drafts.map(line).join("\n")}`;
}

export const crashMessage = (command: string, e: unknown): string => `report-engine, ${command}: a parancs leállt: ${first(e instanceof Error ? e.message : String(e))}`;
