import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { loadEnv, sourceEnv } from "../src/core/env.ts";
import { makeSource, runUptime } from "../src/sources/uptime/index.ts";

const [client] = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients;
const URLS = client.sources.uptime!.urls; // 2 URLs
const A = URLS[0];

// Fake fetch: URL -> responses in order (code or "err"); the last one repeats.
function fakeFetch(plan: Record<string, (number | "err")[]>): typeof fetch {
  return (async (url: string) => {
    const q = plan[url];
    const v = q.length > 1 ? q.shift()! : q[0];
    if (v === "err") throw new Error("ECONNREFUSED");
    return new Response(null, { status: v });
  }) as typeof fetch;
}
const clock = (iso: string) => () => new Date(iso);
const events = (db: any, type?: string) => db.prepare("SELECT type, ts, external_id, meta_json FROM events WHERE (? IS NULL OR type = ?) ORDER BY ts, id").all(type ?? null, type ?? null);
const round = (db: any, iso: string, plan: Record<string, (number | "err")[]>) => runUptime(db, [client], { fetch: fakeFetch(plan), now: clock(iso) });

test("uptime: egy hibás ellenőrzés nem leállás, a második az; kezdet = az első hiba ideje; helyreálláskor időtartam", async () => {
  const db = openDb(":memory:");
  const ok = { [A]: [200], [URLS[1]]: [200] };
  const bad = { [A]: ["err" as const], [URLS[1]]: [200] };
  await round(db, "2026-09-10T10:00:00Z", ok);
  await round(db, "2026-09-10T10:05:00Z", bad); // first error
  assert.equal(events(db).length, 0);
  await round(db, "2026-09-10T10:10:00Z", bad); // second error -> downtime
  await round(db, "2026-09-10T10:15:00Z", bad);
  let ev = events(db);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "downtime_start");
  assert.equal(ev[0].ts, "2026-09-10T10:05:00.000Z");
  await round(db, "2026-09-10T10:20:00Z", ok);
  ev = events(db);
  assert.deepEqual(ev.map((e: any) => e.type), ["downtime_start", "downtime_end"]);
  assert.equal(JSON.parse(ev[1].meta_json).seconds, 15 * 60);
  // a single error does not open a downtime even after recovery
  await round(db, "2026-09-10T10:25:00Z", bad);
  await round(db, "2026-09-10T10:30:00Z", ok);
  assert.equal(events(db).length, 2);
});

test("uptime: 3xx végállapot siker, 5xx hiba", async () => {
  const db = openDb(":memory:");
  await round(db, "2026-09-10T10:00:00Z", { [A]: [301], [URLS[1]]: [500] });
  const r = db.prepare("SELECT url, ok FROM uptime_checks ORDER BY url").all();
  assert.deepEqual(r.map((x: any) => x.ok), [1, 0]);
});

test("uptime: minden hoszt minden URL-je hibás -> runs-hiba, nincs mentett ellenőrzés és nem lép az állapot", async () => {
  const db = openDb(":memory:");
  const other = { ...client, id: "masik-kft", sources: { ...client.sources, uptime: { enabled: true, urls: ["https://masik.example/"] } } };
  const bad = { [A]: ["err" as const], [URLS[1]]: ["err" as const], "https://masik.example/": ["err" as const] };
  const r = (iso: string) => runUptime(db, [client, other], { fetch: fakeFetch(bad), now: clock(iso) });
  assert.equal(await r("2026-09-10T10:00:00Z"), false);
  assert.equal(await r("2026-09-10T10:05:00Z"), false);
  assert.equal(await r("2026-09-10T10:10:00Z"), false);
  assert.equal(db.prepare("SELECT count(*) FROM uptime_checks").pluck().get(), 0);
  assert.equal(db.prepare("SELECT count(*) FROM source_state").pluck().get(), 0);
  assert.equal(events(db).length, 0);
  assert.match(db.prepare("SELECT error FROM runs WHERE status = 'error'").pluck().get() as string, /hálózati/);
});

test("uptime: egyetlen hoszt minden URL-je hibás -> ez leállás, nem hálózati hiba", async () => {
  const db = openDb(":memory:");
  const bad = { [A]: ["err" as const], [URLS[1]]: ["err" as const] };
  await round(db, "2026-09-10T10:00:00Z", bad);
  await round(db, "2026-09-10T10:05:00Z", bad);
  assert.equal(events(db, "downtime_start").length, URLS.length);
});

// Budapest summer time (UTC+2): Sept 10 local day = 2026-09-09T22:00Z .. 2026-09-10T22:00Z.
test("uptime collect: napi aggregátum (avg, p95), Budapest-éjfél határ, nincs 0% üres napra", async () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO uptime_checks (client_id, url, ts, ok, response_ms) VALUES (?, ?, ?, ?, ?)");
  for (let i = 1; i <= 100; i++) ins.run(client.id, A, "2026-09-10T08:00:00Z", 1, i); // 1..100 ms
  ins.run(client.id, A, "2026-09-10T09:00:00Z", 0, null);
  ins.run(client.id, A, "2026-09-09T21:59:00Z", 0, null); // still Sept 9 local (23:59)
  ins.run(client.id, A, "2026-09-10T21:59:00Z", 1, 5000); // still Sept 10 (23:59)
  ins.run(client.id, A, "2026-09-10T22:00:00Z", 0, null); // already Sept 11
  const src = makeSource({ now: clock("2026-09-11T04:15:00Z"), cert: async () => new Date("2027-01-01") });
  await src.collect({ db, env: {} }, client, "2026-09-10");
  const m = (metric: string, dim = "") => db.prepare("SELECT value FROM metrics WHERE metric = ? AND dimension = ? AND date = '2026-09-10'").pluck().get(metric, dim);
  assert.equal(m("checks"), 102);
  assert.equal(m("uptime_pct"), (101 / 102) * 100);
  assert.equal(m("p95_response_ms"), 96); // 101 successful values (1..100, 5000): the ceil(0.95·101) = 96th element
  assert.equal(m("avg_response_ms"), 10050 / 101);
  assert.equal(m("checks", A), 102);
  assert.equal(m("checks", URLS[1]), undefined);
  await src.collect({ db, env: {} }, client, "2026-09-10"); // rerun: does not duplicate
  assert.equal(db.prepare("SELECT count(*) FROM metrics WHERE date = '2026-09-10'").pluck().get(), 8);
  await src.collect({ db, env: {} }, client, "2026-09-12"); // day without checks: no row
  assert.equal(db.prepare("SELECT count(*) FROM metrics WHERE date = '2026-09-12'").pluck().get(), 0);
  assert.equal(src.defaultDay(), "2026-09-10");
});

test("uptime collect: tanúsítvány 14 napon belül -> napi egy esemény; 35 napnál régebbi sorok törlődnek", async () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO uptime_checks (client_id, url, ts, ok, response_ms) VALUES (?, ?, ?, 1, 10)");
  ins.run(client.id, A, "2026-07-01T10:00:00Z");
  ins.run(client.id, A, "2026-09-10T10:00:00Z");
  const hosts: string[] = [];
  const mk = (iso: string, exp: string) => makeSource({ now: clock(iso), cert: async (h) => (hosts.push(h), new Date(exp)) });
  const ctx = { db, env: {} };
  await mk("2026-09-11T04:15:00Z", "2026-09-20T00:00:00Z").collect(ctx, client, "2026-09-10");
  await mk("2026-09-11T09:00:00Z", "2026-09-20T00:00:00Z").collect(ctx, client, "2026-09-10"); // same day
  assert.equal(events(db, "cert_expiring").length, 1);
  assert.equal(events(db, "cert_expiring")[0].external_id, "cert:teszt.hu:2026-09-11");
  assert.deepEqual([...new Set(hosts)], ["teszt.hu"]);
  await mk("2026-09-12T04:15:00Z", "2026-12-20T00:00:00Z").collect(ctx, client, "2026-09-11"); // far from expiry
  assert.equal(events(db, "cert_expiring").length, 1);
  assert.equal(db.prepare("SELECT count(*) FROM uptime_checks").pluck().get(), 1);
});

test("uptime summarize: havi rendelkezésre állás súlyozva, leállások, napi trend; adat nélkül null", async () => {
  const db = openDb(":memory:");
  const src = makeSource({ now: clock("2026-10-01T04:00:00Z"), cert: async () => new Date("2027-01-01") });
  const ctx = { db, env: {} };
  assert.equal(await src.summarize(ctx, client, "2026-09"), null);
  const ins = db.prepare("INSERT INTO uptime_checks (client_id, url, ts, ok, response_ms) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 4; i++) ins.run(client.id, A, "2026-09-10T08:00:00Z", i ? 1 : 0, i ? 100 : null); // 75%, 4 pcs
  ins.run(client.id, A, "2026-09-11T08:00:00Z", 1, 200); // 100%, 1 pc
  await src.collect(ctx, client, "2026-09-10");
  await src.collect(ctx, client, "2026-09-11");
  await round(db, "2026-09-12T10:00:00Z", { [A]: ["err"], [URLS[1]]: [200] });
  await round(db, "2026-09-12T10:05:00Z", { [A]: ["err"], [URLS[1]]: [200] });
  await round(db, "2026-09-12T10:35:00Z", { [A]: [200], [URLS[1]]: [200] });
  const d = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(d.availabilityPct, (4 / 5) * 100); // (0.75*4 + 1*1) / 5
  assert.equal(d.downtimes.length, 1);
  assert.equal(d.downtimeSeconds, 35 * 60); // from the first failed check (10:00)
  assert.deepEqual(d.daily.map((x: any) => [x.date, x.avgResponseMs]), [["2026-09-10", 100], ["2026-09-11", 200]]);
});

test("env: a hiányzó forrásváltozó csak a forrás futását bukja, névvel és érték nélkül", () => {
  assert.doesNotThrow(() => loadEnv("collect", {}));
  assert.throws(() => sourceEnv("worklog", {}), /GITHUB_TOKEN/);
  assert.equal(sourceEnv("worklog", { GITHUB_TOKEN: "x" }).GITHUB_TOKEN, "x");
});

test("uptime summarize: a hónap végén még tartó leállás is látszik, a hónap végéig (Budapest-éjfél) számolva", async () => {
  const db = openDb(":memory:");
  const src = makeSource();
  const ctx = { db, env: {} };
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'checks', '', 'day', '2026-09-30', 10)").run(client.id);
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'uptime_pct', '', 'day', '2026-09-30', 50)").run(client.id);
  await round(db, "2026-09-30T21:00:00Z", { [A]: ["err"], [URLS[1]]: [200] }); // 23:00 in Budapest
  await round(db, "2026-09-30T21:05:00Z", { [A]: ["err"], [URLS[1]]: [200] });
  let d = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.deepEqual(d.downtimes, [{ url: A, start: "2026-09-30T21:00:00.000Z", end: null, seconds: 3600, ongoing: true }]);
  assert.equal(d.downtimeSeconds, 3600);
  // Recovers in October: in September still "ongoing", in October ended with the full duration.
  await round(db, "2026-10-01T01:00:00Z", { [A]: [200], [URLS[1]]: [200] });
  d = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(d.downtimes[0].ongoing, true);
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'checks', '', 'day', '2026-10-01', 10)").run(client.id);
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'uptime_pct', '', 'day', '2026-10-01', 90)").run(client.id);
  d = (await src.summarize(ctx, client, "2026-10"))!.data as any;
  // Spanning downtime: the start is the real one (Sept 30 21:00Z), but in October only the 3 hours falling in the month (from 22:00Z to 01:00Z) count.
  assert.deepEqual(d.downtimes.map((x: any) => [x.start, x.ongoing ?? false, x.seconds]), [["2026-09-30T21:00:00.000Z", false, 3 * 3600]]);
  assert.equal(d.downtimeSeconds, 3 * 3600);
});

test("uptime summarize: már nem konfigurált URL lezáratlan leállása nem tartó leállás", async () => {
  const db = openDb(":memory:");
  const ctx = { db, env: {} };
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'checks', '', 'day', '2026-09-30', 10)").run(client.id);
  db.prepare("INSERT INTO metrics VALUES (?, 'uptime', 'uptime_pct', '', 'day', '2026-09-30', 50)").run(client.id);
  await round(db, "2026-09-30T21:00:00Z", { [A]: ["err"], [URLS[1]]: [200] });
  const gone = { ...client, sources: { ...client.sources, uptime: { enabled: true, urls: [URLS[1]] } } };
  const d = (await makeSource().summarize(ctx, gone, "2026-09"))!.data as any;
  assert.deepEqual(d.downtimes, []);
});
