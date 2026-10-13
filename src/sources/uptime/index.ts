import { connect } from "node:tls";
import { addDays, addMonths, budapestDay, budapestMidnight, today } from "../../core/dates.ts";
import type { Db } from "../../core/db.ts";
import { withRun } from "../../core/runs.ts";
import type { Client, Section, Source } from "../types.ts";

const SOURCE = "uptime";
const TIMEOUT_MS = 10_000;
const KEEP_DAYS = 35;
const CERT_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

// The "day" boundary is Europe/Budapest local midnight (core/dates.ts budapestDay).

type Check = { url: string; ok: boolean; status: number | null; ms: number | null; error: string | null };

export interface Deps {
  fetch?: typeof fetch;
  cert?: (host: string, port: number) => Promise<Date>; // certificate expiry
  now?: () => Date;
}

// fetch does not expose the certificate, hence a direct TLS connection (with SNI). rejectUnauthorized: false,
// so that the expiry of an expired/invalid certificate can be read too; we do not validate the chain.
const peerCertExpiry = (host: string, port: number) =>
  new Promise<Date>((resolve, reject) => {
    const s = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const valid_to = s.getPeerCertificate()?.valid_to;
      s.end();
      valid_to ? resolve(new Date(valid_to)) : reject(new Error("nincs tanúsítvány"));
    });
    s.on("error", reject);
    s.on("timeout", () => s.destroy(new Error("időtúllépés")));
  });

async function check(f: typeof fetch, url: string): Promise<Check> {
  const t0 = performance.now();
  try {
    const res = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    const ms = Math.round(performance.now() - t0);
    await res.body?.cancel();
    return { url, ok: res.status >= 200 && res.status < 400, status: res.status, ms, error: null };
  } catch (e) {
    const error = (e as Error).name === "TimeoutError" ? "időtúllépés" : (e as Error).message;
    return { url, ok: false, status: null, ms: null, error };
  }
}

const urlsOf = (c: Client) => c.sources.uptime!.urls;
const event = (db: Db, clientId: string, type: string, id: string, ts: string, title: string, meta: object) =>
  db
    .prepare("INSERT OR IGNORE INTO events (client_id, source, external_id, type, ts, title, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(clientId, SOURCE, id, type, ts, title, JSON.stringify(meta));

// State per URL (source_state key: "state:<url>"). The start of an outage is the time of the FIRST failed check;
// it takes two consecutive failures, a single failed check is not an outage.
type State = { fails: number; since?: string; down?: boolean };

function advance(db: Db, clientId: string, r: Check, ts: string): void {
  const key = `state:${r.url}`;
  const raw = db.prepare("SELECT value FROM source_state WHERE client_id = ? AND source = ? AND key = ?").pluck().get(clientId, SOURCE, key) as string | undefined;
  const s: State = raw ? JSON.parse(raw) : { fails: 0 };
  let next: State;
  if (r.ok) {
    if (s.down) {
      const seconds = Math.round((Date.parse(ts) - Date.parse(s.since!)) / 1000);
      event(db, clientId, "downtime_end", `downtime_end:${r.url}:${s.since}`, ts, `Helyreállt: ${r.url}`, { url: r.url, start: s.since, end: ts, seconds });
    }
    next = { fails: 0 };
  } else {
    const since = s.fails ? s.since : ts;
    const down = s.down || s.fails + 1 >= 2;
    if (down && !s.down) event(db, clientId, "downtime_start", `downtime_start:${r.url}:${since}`, since!, `Leállás: ${r.url}`, { url: r.url, start: since });
    next = { fails: s.fails + 1, since, down };
  }
  db.prepare("INSERT INTO source_state (client_id, source, key, value) VALUES (?, ?, ?, ?) ON CONFLICT (client_id, source, key) DO UPDATE SET value = excluded.value")
    .run(clientId, SOURCE, key, JSON.stringify(next));
}

// One round of the `uptime` command: first every URL of every client, then one withRun per client.
// If EVERY URL fails, that is a network fault of the VPS: no checks are saved from the round and no state advances,
// only a runs error is written. With a single host (e.g. only the pilot client) this cannot be distinguished
// from a real outage, so there it counts as an outage.
export async function runUptime(db: Db, clients: Client[], deps: Deps = {}): Promise<boolean> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const targets = clients.filter((c) => c.sources.uptime?.enabled);
  const ts = now().toISOString();
  const results = await Promise.all(targets.map((c) => Promise.all(urlsOf(c).map((u) => check(f, u)))));
  const flat = results.flat();
  const hosts = new Set(flat.map((r) => new URL(r.url).host));
  const allFailed = hosts.size >= 2 && flat.every((r) => !r.ok);
  let ok = true;
  for (const [i, client] of targets.entries()) {
    ok = (await withRun(db, SOURCE, client.id, today(now()), async () => {
      if (allFailed) throw new Error("minden ügyfél minden URL-je hibás: a VPS hálózati hibájának tekintjük, a kör nincs mentve");
      const ins = db.prepare("INSERT INTO uptime_checks (client_id, url, ts, ok, status, response_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (const r of results[i]) {
          ins.run(client.id, r.url, ts, r.ok ? 1 : 0, r.status, r.ms, r.error);
          advance(db, client.id, r, ts);
        }
      })();
    })) && ok;
  }
  return ok;
}

// p95: nearest-rank (the ceil(0.95·n)-th element of the sorted list).
const p95 = (sorted: number[]) => sorted[Math.ceil(0.95 * sorted.length) - 1];

const UPSERT = `INSERT INTO metrics (client_id, source, metric, dimension, period, date, value)
  VALUES (?, 'uptime', ?, ?, 'day', ?, ?)
  ON CONFLICT (client_id, source, metric, dimension, period, date) DO UPDATE SET value = excluded.value`;

export function makeSource(deps: Deps = {}): Source {
  const now = deps.now ?? (() => new Date());
  const certOf = deps.cert ?? peerCertExpiry;
  return {
    id: SOURCE,
    defaultDay: () => addDays(today(now()), -1), // the previous day (complete after the 06:15 collect)

    // Daily aggregate: dimension '' = all of the client's URLs together (this is what summarize reads), dimension = URL
    // = per URL. Response time is computed only from successful checks (the 10 s timeout would distort the picture).
    // No row is written for a day with zero checks (not 0%): summarize gives "no data".
    async collect(ctx, client, day) {
      const { db } = ctx;
      const rows = db
        .prepare("SELECT url, ts, ok, response_ms FROM uptime_checks WHERE client_id = ? AND ts >= ? AND ts < ?")
        .all(client.id, `${addDays(day, -1)}T00:00:00Z`, `${addDays(day, 2)}T00:00:00Z`) // ±1 day buffer, the exact filtering is by Budapest time
        .filter((r: any) => budapestDay(r.ts) === day) as { url: string; ok: number; response_ms: number | null }[];
      const groups: [string, typeof rows][] = [["", rows], ...urlsOf(client).map((u): [string, typeof rows] => [u, rows.filter((r) => r.url === u)])];
      db.transaction(() => {
        for (const [dim, g] of groups) {
          if (!g.length) continue;
          const up = (m: string, v: number) => db.prepare(UPSERT).run(client.id, m, dim, day, v);
          up("checks", g.length);
          up("uptime_pct", (g.filter((r) => r.ok).length / g.length) * 100);
          const ms = g.filter((r) => r.ok && r.response_ms != null).map((r) => r.response_ms!).sort((a, b) => a - b);
          if (ms.length) {
            up("avg_response_ms", ms.reduce((a, b) => a + b, 0) / ms.length);
            up("p95_response_ms", p95(ms));
          }
        }
      })();

      // TLS certificate: in the daily collect, so once a day per host; the external_id contains today's date,
      // so a rerun does not duplicate either. An error (e.g. unreachable host) does not fail the collection.
      const nowD = now();
      for (const u of new Set(urlsOf(client).filter((u) => u.startsWith("https:")).map((u) => new URL(u).host))) {
        const [host, port] = u.split(":");
        try {
          const exp = await certOf(host, Number(port || 443));
          const days = Math.floor((exp.getTime() - nowD.getTime()) / DAY_MS);
          if (days < CERT_WARN_DAYS)
            event(db, client.id, "cert_expiring", `cert:${host}:${today(nowD)}`, nowD.toISOString(), `A(z) ${host} tanúsítványa ${days < 0 ? "lejárt" : `${days} nap múlva lejár`}`, { host, valid_to: exp.toISOString(), days });
        } catch (e) {
          console.error(`${client.id}: ${host} tanúsítványa nem olvasható: ${(e as Error).message}`);
        }
      }

      // Maintenance: raw checks older than 35 days and old uptime runs (created every 5 minutes).
      const cutoff = new Date(nowD.getTime() - KEEP_DAYS * DAY_MS).toISOString();
      db.prepare("DELETE FROM uptime_checks WHERE ts < ?").run(cutoff);
      db.prepare("DELETE FROM runs WHERE source = ? AND finished_at < ?").run(SOURCE, cutoff);
    },

    async summarize(ctx, client, month) {
      const m = ctx.db
        .prepare("SELECT date, metric, value FROM metrics WHERE client_id = ? AND source = 'uptime' AND dimension = '' AND date LIKE ?")
        .all(client.id, `${month}-%`) as { date: string; metric: string; value: number }[];
      if (!m.length) return null;
      const days = new Map<string, Record<string, number>>();
      for (const r of m) days.set(r.date, { ...days.get(r.date), [r.metric]: r.value });
      let checks = 0, up = 0;
      for (const d of days.values()) {
        checks += d.checks;
        up += (d.uptime_pct / 100) * d.checks; // weighted by number of checks
      }
      const downtimes = (ctx.db
        .prepare("SELECT ts, meta_json FROM events WHERE client_id = ? AND source = 'uptime' AND type = 'downtime_end' AND ts >= ? AND ts < ? ORDER BY ts")
        .all(client.id, `${addDays(`${month}-01`, -1)}T00:00:00Z`, `${addMonths(month, 1)}-02T00:00:00Z`) as { ts: string; meta_json: string }[])
        .filter((e) => budapestDay(e.ts).startsWith(month))
        .map((e) => JSON.parse(e.meta_json) as { url: string; start: string; end: string | null; seconds: number; ongoing?: boolean });
      // For an outage spanning months only the part within the month counts (the displayed start is the real one).
      const monthStart = budapestMidnight(`${month}-01`);
      const inMonth = (start: string, end: string) => Math.max(0, Math.round((Date.parse(end) - Math.max(Date.parse(start), Date.parse(monthStart))) / 1000));
      for (const d of downtimes) if (d.end) d.seconds = Math.min(d.seconds, inMonth(d.start, d.end));
      // An outage still ongoing at the end of the month (Budapest midnight) is included too, with the duration counted to the end of the month.
      const monthEnd = budapestMidnight(`${addMonths(month, 1)}-01`);
      const ongoing = ctx.db
        .prepare(
          `SELECT s.meta_json FROM events s WHERE s.client_id = ? AND s.source = 'uptime' AND s.type = 'downtime_start' AND s.ts < ?
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.client_id = s.client_id AND e.source = 'uptime' AND e.type = 'downtime_end'
             AND e.external_id = 'downtime_end:' || substr(s.external_id, length('downtime_start:') + 1) AND e.ts < ?)`,
        )
        .pluck()
        .all(client.id, monthEnd, monthEnd) as string[];
      for (const raw of ongoing) {
        const { url, start } = JSON.parse(raw) as { url: string; start: string };
        if (!urlsOf(client).includes(url)) continue; // no longer a configured URL (removed): not an ongoing outage
        downtimes.push({ url, start, end: null, seconds: inMonth(start, monthEnd), ongoing: true });
      }
      downtimes.sort((a, b) => a.start.localeCompare(b.start));
      const data: Section["data"] = {
        month,
        availabilityPct: (up / checks) * 100,
        downtimes, // outages that ended in the month and those still ongoing at the end of the month (ongoing, end: null)
        downtimeSeconds: downtimes.reduce((a, d) => a + d.seconds, 0),
        daily: [...days].sort().map(([date, d]) => ({ date, avgResponseMs: d.avg_response_ms ?? null, p95ResponseMs: d.p95_response_ms ?? null })),
      };
      return { source: SOURCE, data };
    },
  };
}

export const uptime = makeSource();
