import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createQuery, makeSource, type Dimension, type Group, type Query } from "../src/sources/cloudflare/index.ts";

const base = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients[0];
const client = { ...base, sources: { ...base.sources, cloudflare: { enabled: true, siteTag: "0123456789abcdef0123456789abcdef" } } };
const g = (dim: Dimension, key: string, pageviews: number, visits: number): Group => ({ count: pageviews, sum: { visits }, dimensions: { [dim]: key } });

// Fake API: fixture response by dimension, calls recorded.
function fake(responses: Partial<Record<Dimension, Group[]>>) {
  const calls: [string, string, Dimension, number][] = [];
  const q: Query = async (_site, from, to, dim, limit) => {
    calls.push([from, to, dim, limit]);
    return responses[dim] ?? [];
  };
  return { src: makeSource(() => q), calls };
}
const ctxOf = () => ({ db: openDb(":memory:"), env: {} });

test("cloudflare collect: napi látogatás és megtekintés, kétszer futtatva sem duplikál", async () => {
  const { src } = fake({ date: [g("date", "2026-09-10", 30, 12)] });
  const ctx = ctxOf();
  await src.collect(ctx, client, "2026-09-10");
  await src.collect(ctx, client, "2026-09-10");
  const rows = ctx.db.prepare("SELECT metric, dimension, period, date, value FROM metrics ORDER BY metric").all();
  assert.deepEqual(rows, [
    { metric: "pageviews", dimension: "", period: "day", date: "2026-09-10", value: 30 },
    { metric: "visits", dimension: "", period: "day", date: "2026-09-10", value: 12 },
  ]);
});

test("cloudflare collect: alapértelmezett napra 7 napos ablak, explicit napra egy nap", async () => {
  const { src, calls } = fake({});
  const end = src.defaultDay();
  await src.collect(ctxOf(), client, end);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(calls[0].slice(0, 2), [start, end]);
  await src.collect(ctxOf(), client, "2026-09-10");
  assert.deepEqual(calls[1].slice(0, 2), ["2026-09-10", "2026-09-10"]);
});

test("cloudflare collectMonthly: oldal- és forráslista, a saját domain (0 látogatás) kimarad, újrafutásnál nincs elavult sor", async () => {
  const ctx = ctxOf();
  await fake({ requestPath: [g("requestPath", "/regi", 1, 1)] }).src.collectMonthly!(ctx, client, "2026-09");
  const { src, calls } = fake({
    requestPath: [g("requestPath", "/", 50, 20)],
    refererHost: [g("refererHost", "www.google.com", 15, 10), g("refererHost", "", 8, 6), g("refererHost", "teszt.hu", 40, 0)],
  });
  await src.collectMonthly!(ctx, client, "2026-09");
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["2026-09-01", "2026-09-30", "requestPath"], ["2026-09-01", "2026-09-30", "refererHost"]]);
  const dims = ctx.db.prepare("SELECT DISTINCT dimension FROM metrics ORDER BY 1").pluck().all();
  assert.deepEqual(dims, ["path:/", "referer:", "referer:www.google.com"]);
});

test("cloudflare summarize: adat nélkül null, előző hónap nélkül nincs összevetés, utána arány", async () => {
  const ctx = ctxOf();
  const { src } = fake({ date: [g("date", "2026-09-01", 30, 10), g("date", "2026-09-02", 30, 10)], requestPath: [g("requestPath", "/a", 5, 2), g("requestPath", "/b", 9, 1)] });
  assert.equal(await src.summarize(ctx, client, "2026-09"), null);
  await src.collect(ctx, client, "2026-09-01");
  await src.collectMonthly!(ctx, client, "2026-09");
  const s = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.deepEqual(s.totals, { visits: 20, pageviews: 60 });
  assert.equal(s.vsPreviousMonth, null);
  assert.deepEqual(s.topPages.map((p: any) => p.key), ["/b", "/a"]);

  await fake({ date: [g("date", "2026-08-15", 40, 16)] }).src.collect(ctx, client, "2026-08-15");
  const s2 = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(s2.vsPreviousMonth.visits, 0.25);
  assert.equal(s2.vsPreviousMonth.pageviews, 0.5);
});

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

test("cloudflare api: változók és szűrők a kérésben, a token nem kerül hibaüzenetbe, GraphQL-hiba és hiányzó fiók hibát dob", async () => {
  let sent: any;
  const ok = createQuery("titok", "acc", async (_u, init) => {
    sent = { auth: (init!.headers as any).authorization, ...JSON.parse(init!.body as string) };
    return res(200, { data: { viewer: { accounts: [{ rows: [g("date", "2026-09-01", 3, 1)] }] } } });
  });
  assert.equal((await ok("site", "2026-09-01", "2026-09-07", "date", 100)).length, 1);
  assert.equal(sent.auth, "Bearer titok");
  assert.deepEqual(sent.variables, { account: "acc", site: "site", from: "2026-09-01", to: "2026-09-07", limit: 100 });
  assert.match(sent.query, /rumPageloadEventsAdaptiveGroups/);
  assert.match(sent.query, /bot: 0/);
  assert.match(sent.query, /dimensions \{ date \}/);

  const denied = createQuery("titok", "acc", async () => res(403));
  await assert.rejects(denied("s", "a", "b", "date", 1), (e: Error) => /Account Analytics Read/.test(e.message) && !e.message.includes("titok"));
  const gqlErr = createQuery("t", "acc", async () => res(200, { data: null, errors: [{ message: "bad field" }] }));
  await assert.rejects(gqlErr("s", "a", "b", "date", 1), /bad field/);
  const noAcc = createQuery("t", "acc", async () => res(200, { data: { viewer: { accounts: [] } } }));
  await assert.rejects(noAcc("s", "a", "b", "date", 1), /CLOUDFLARE_ACCOUNT_ID/);
});

test("cloudflare backfill --dry-run: nem hív API-t", async () => {
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

test("cloudflare riport: szekció, email-szám és AI-bemenet; az útvonal escape-elve, üres forrás = közvetlen", async () => {
  const { renderReport } = await import("../src/report/index.ts");
  const { buildEmail } = await import("../src/report/email.ts");
  const { aiInput } = await import("../src/report/ai.ts");
  const ctx = ctxOf();
  const { src } = fake({
    date: [g("date", "2026-09-01", 30, 10)],
    requestPath: [g("requestPath", "/<script>", 5, 2)],
    refererHost: [g("refererHost", "", 8, 6)],
  });
  await src.collect(ctx, client, "2026-09-01");
  await src.collectMonthly!(ctx, client, "2026-09");
  const sections: [string, any][] = [["cloudflare", await src.summarize(ctx, client, "2026-09")]];
  const page = renderReport(client, "2026-09", sections, { now: new Date("2026-10-04T07:00:00Z") });
  assert.match(page, /Látogatottság/);
  assert.match(page, /&lt;script&gt;/);
  assert.ok(!page.includes("/<script>"));
  assert.match(page, /Közvetlenül/);
  assert.ok(buildEmail(client, "2026-09", sections).html.includes("Látogatás az oldalon"));
  assert.deepEqual(aiInput(client, "2026-09", sections).traffic, {
    visits: 10, pageViews: 30, vsPreviousMonth: null, topPages: [{ page: "/<script>", pageViews: 5 }], topReferrers: [{ source: "direct", visits: 6 }],
    aiAssistantVisits: { visits: 0, vsPreviousMonthPct: null, bySource: [] },
  });
});

test("cloudflare summarize: AI asszisztensek a hivatkozókból (aldomain is), összevetés az előző havi listával", async () => {
  const ctx = ctxOf();
  const { aiAssistant } = await import("../src/sources/cloudflare/index.ts");
  assert.equal(aiAssistant("www.perplexity.ai"), "Perplexity");
  assert.equal(aiAssistant("notchatgpt.com"), undefined);
  await fake({ refererHost: [g("refererHost", "chatgpt.com", 4, 4)] }).src.collectMonthly!(ctx, client, "2026-08");
  const { src } = fake({
    date: [g("date", "2026-09-01", 30, 10)],
    refererHost: [g("refererHost", "chatgpt.com", 5, 4), g("refererHost", "chat.openai.com", 2, 2), g("refererHost", "www.perplexity.ai", 3, 3), g("refererHost", "www.google.com", 9, 9)],
  });
  await src.collect(ctx, client, "2026-09-01");
  await src.collectMonthly!(ctx, client, "2026-09");
  const s = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.deepEqual(s.aiReferrals, { visits: 9, sources: [{ name: "ChatGPT", visits: 6 }, { name: "Perplexity", visits: 3 }], vsPreviousMonth: 1.25 });
  const { renderReport } = await import("../src/report/index.ts");
  const page = renderReport(client, "2026-09", [["cloudflare", { source: "cloudflare", data: s }]], { now: new Date("2026-10-04T07:00:00Z") });
  assert.match(page, /AI asszisztensből érkezett/);
  assert.match(page, /Alsó becslés/);
});
