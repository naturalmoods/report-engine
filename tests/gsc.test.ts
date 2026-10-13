import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createQuery, type Query, type QueryBody, type Row } from "../src/sources/gsc/api.ts";
import { makeSource, monthTotals } from "../src/sources/gsc/index.ts";

const [client] = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients;
const row = (key: string, clicks: number, impressions: number, position: number): Row => ({
  keys: [key], clicks, impressions, ctr: clicks / impressions, position,
});

// Fake API: returns a fixture response by dimension, and counts the calls.
function fake(responses: Record<string, Row[]>) {
  const calls: QueryBody[] = [];
  const q: Query = async (_p, body) => {
    calls.push(body);
    return responses[body.dimensions[0]] ?? [];
  };
  return { src: makeSource(() => q), calls };
}
const ctxOf = () => ({ db: openDb(":memory:"), env: {} });
const count = (db: ReturnType<typeof openDb>) => db.prepare("SELECT count(*) FROM metrics").pluck().get();

test("gsc collect: API-válasz -> metrics sorok, kétszer futtatva sem duplikál", async () => {
  const { src } = fake({ date: [row("2026-09-10", 5, 100, 3.5)] });
  const ctx = ctxOf();
  await src.collect(ctx, client, "2026-09-10");
  await src.collect(ctx, client, "2026-09-10");
  const rows = ctx.db.prepare("SELECT metric, dimension, period, date, value FROM metrics ORDER BY metric").all();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.find((r: any) => r.metric === "clicks"), { metric: "clicks", dimension: "", period: "day", date: "2026-09-10", value: 5 });
});

test("gsc collectMonthly: toplisták, újrafutásnál nem marad elavult sor", async () => {
  const ctx = ctxOf();
  await fake({ query: [row("régi", 1, 10, 9)], page: [] }).src.collectMonthly!(ctx, client, "2026-09");
  const { src, calls } = fake({ query: [row("új", 2, 20, 4)], page: [row("https://teszt.hu/", 3, 30, 2)] });
  await src.collectMonthly!(ctx, client, "2026-09");
  assert.deepEqual(calls.map((c) => [c.startDate, c.endDate, c.rowLimit]), [["2026-09-01", "2026-09-30", 500], ["2026-09-01", "2026-09-30", 500]]);
  const dims = ctx.db.prepare("SELECT DISTINCT dimension FROM metrics ORDER BY 1").pluck().all();
  assert.deepEqual(dims, ["page:https://teszt.hu/", "query:új"]);
  assert.equal(count(ctx.db), 6);
});

test("gsc: megjelenéssel súlyozott pozíció és CTR (kézzel: (2*100+6*300)/400 = 5)", async () => {
  const ctx = ctxOf();
  await fake({ date: [row("2026-09-01", 10, 100, 2), row("2026-09-02", 30, 300, 6)] }).src.collect(ctx, client, "2026-09-01");
  const t = monthTotals(ctx.db, client.id, "2026-09")!;
  assert.equal(t.position, 5);
  assert.equal(t.clicks, 40);
  assert.equal(t.ctr, 0.1);
});

test("gsc summarize: előző havi adat nélkül is működik, utána változás és mozgatók", async () => {
  const ctx = ctxOf();
  const { src } = fake({ date: [row("2026-09-01", 10, 100, 2)], query: [row("a", 10, 100, 2), row("b", 5, 50, 3)], page: [] });
  assert.equal(await src.summarize(ctx, client, "2026-09"), null);
  await src.collect(ctx, client, "2026-09-01");
  await src.collectMonthly!(ctx, client, "2026-09");
  const s = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(s.vsPreviousMonth, null);
  assert.equal(s.vsPreviousYear, null);
  assert.equal(s.queryMovers, null);
  assert.equal(s.topQueries[0].key, "a");

  const prev = fake({ date: [row("2026-08-01", 5, 100, 2)], query: [row("a", 4, 100, 2), row("c", 9, 100, 2)], page: [] }).src;
  await prev.collect(ctx, client, "2026-08-01");
  await prev.collectMonthly!(ctx, client, "2026-08");
  const s2 = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(s2.vsPreviousMonth.clicks, 1);
  assert.deepEqual(s2.queryMovers.up.map((m: any) => m.key), ["a", "b"]);
  assert.deepEqual(s2.queryMovers.down.map((m: any) => m.key), ["c"]);
});

test("gsc backfill --dry-run: nem hív API-t", async () => {
  const { src, calls } = fake({});
  const log = console.log;
  const lines: string[] = [];
  console.log = (l: string) => lines.push(l);
  try {
    await src.backfill!({ ...ctxOf(), dryRun: true }, client, "2026-01");
  } finally {
    console.log = log;
  }
  assert.equal(calls.length, 0);
  assert.ok(lines.length > 0);
});

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

test("gsc api: 429/5xx-re újrapróbál, 403-ra az e-mail címet kéri felvenni", async () => {
  const seq = [res(429), res(503), res(200, { rows: [row("x", 1, 2, 3)] })];
  const sleeps: number[] = [];
  const q = createQuery("/nincs", { fetch: async () => seq.shift()!, sleep: async (ms) => void sleeps.push(ms), token: async () => "t" });
  assert.equal((await q("sc-domain:teszt.hu", { startDate: "a", endDate: "b", dimensions: ["date"] })).length, 1);
  assert.deepEqual(sleeps, [1000, 2000]);

  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "gsc-")), "sa.json");
  writeFileSync(f, JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com" }));
  const denied = createQuery(f, { fetch: async () => res(403, { error: { message: "no" } }), token: async () => "t" });
  await assert.rejects(denied("sc-domain:teszt.hu", { startDate: "a", endDate: "b", dimensions: ["date"] }), /sa@proj\.iam\.gserviceaccount\.com/);
});

test("gsc collect: alapértelmezett napra 5 napos gördülő ablak egy hívással, explicit napra egy nap", async () => {
  const { src, calls } = fake({});
  await src.collect(ctxOf(), client, src.defaultDay());
  const end = src.defaultDay(), start = new Date(Date.parse(`${end}T00:00:00Z`) - 4 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(calls.map((c) => [c.startDate, c.endDate]), [[start, end]]);
  await src.collect(ctxOf(), client, "2026-09-10");
  assert.deepEqual(calls[1] && [calls[1].startDate, calls[1].endDate], ["2026-09-10", "2026-09-10"]);
});
