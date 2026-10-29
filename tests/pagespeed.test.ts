import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createRun, makeSource, type Psi } from "../src/sources/pagespeed/index.ts";

const base = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients[0];
const client = { ...base, sources: { ...base.sources, pagespeed: { enabled: true } } };
const ctxOf = () => ({ db: openDb(":memory:"), env: {} });
const at = (day: string) => () => new Date(`${day}T10:00:00Z`);

const psi = (score: number, lcp: number, field?: { lcp: number; inp: number; cls: number }): Psi => ({
  lighthouseResult: {
    categories: { performance: { score } },
    audits: { "largest-contentful-paint": { numericValue: lcp }, "cumulative-layout-shift": { numericValue: 0.02 }, "total-blocking-time": { numericValue: 150 } },
  },
  originLoadingExperience: field && {
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: field.lcp },
      INTERACTION_TO_NEXT_PAINT: { percentile: field.inp },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: field.cls },
    },
  },
});

test("pagespeed collect + summarize: a laborpontszám a napok mediánja, a valós adat a hónap utolsó mérése, változás az előző hónaphoz", async () => {
  const ctx = ctxOf();
  const days: [string, Psi][] = [
    ["2026-08-20", psi(0.6, 3000)],
    ["2026-09-01", psi(0.7, 2800, { lcp: 3100, inp: 180, cls: 5 })],
    ["2026-09-02", psi(0.9, 2000)],
    ["2026-09-03", psi(0.8, 2400, { lcp: 2300, inp: 250, cls: 30 })],
  ];
  for (const [day, r] of days) await makeSource({ run: () => async () => r, now: at(day) }).collect(ctx, client, day);
  // Rerun of a day: upsert, no duplicate.
  await makeSource({ run: () => async () => psi(0.8, 2400, { lcp: 2300, inp: 250, cls: 30 }), now: at("2026-09-03") }).collect(ctx, client, "2026-09-03");
  const src = makeSource({ now: at("2026-09-03") });
  const d = (await src.summarize(ctx, client, "2026-09"))!.data as any;
  assert.deepEqual(d.pages, [{ url: "https://teszt.hu/", score: 80, lcpMs: 2400, cls: 0.02, tbtMs: 150, days: 3, scoreChange: 20 }]);
  assert.deepEqual(d.field, { date: "2026-09-03", lcpMs: 2300, inpMs: 250, cls: 0.3 });
  assert.equal(await src.summarize(ctx, client, "2026-07"), null);

  const { renderReport } = await import("../src/report/index.ts");
  const page = renderReport(client, "2026-09", [["pagespeed", { source: "pagespeed", data: d }]], { now: new Date("2026-10-04T07:00:00Z") });
  assert.match(page, /Teljesítménypontszám \(mobil\)/);
  assert.match(page, /<span class="good">\+20<\/span>/);
  assert.match(page, /Reagálás kattintásra \(INP\)/);
  assert.match(page, /<span class="bad">gyenge<\/span>/); // CLS 0.3

  const { aiInput } = await import("../src/report/ai.ts");
  assert.deepEqual(aiInput(client, "2026-09", [["pagespeed", { source: "pagespeed", data: d }]]).speed, {
    mobileScore: 80, mobileScoreRating: "javítandó", scoreChange: 20,
    realUsers: { lcpSeconds: 2.3, lcpRating: "jó", inpMs: 250, inpRating: "javítandó", cls: 0.3, clsRating: "gyenge" },
  });
});

test("pagespeed: valós adat nélkül is megy; Lighthouse-hibánál a run hibás; múltbeli nap kimarad", async () => {
  const ctx = ctxOf();
  await makeSource({ run: () => async () => psi(0.95, 1500), now: at("2026-09-01") }).collect(ctx, client, "2026-09-01");
  const d = (await makeSource().summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(d.field, null);
  const { renderReport } = await import("../src/report/index.ts");
  assert.match(renderReport(client, "2026-09", [["pagespeed", { source: "pagespeed", data: d }]], { now: new Date() }), /Valós felhasználói adat nincs/);

  const broken = makeSource({ run: () => async () => ({ lighthouseResult: { runtimeError: { code: "NO_FCP" } } }), now: at("2026-09-02") });
  await assert.rejects(broken.collect(ctx, client, "2026-09-02"), /https:\/\/teszt\.hu\/: Lighthouse-hiba: NO_FCP/);

  let called = false;
  const log = console.log;
  console.log = () => {};
  try {
    await makeSource({ run: () => async () => ((called = true), psi(1, 1)), now: at("2026-09-05") }).collect(ctx, client, "2026-09-01");
  } finally {
    console.log = log;
  }
  assert.equal(called, false);
});

test("pagespeed api: mobil, performance, a kulcs a kérésben van, de a hibaüzenetben nincs", async () => {
  let sent = "";
  const ok = createRun("titok", async (u) => ((sent = String(u)), new Response(JSON.stringify(psi(0.5, 1)), { status: 200 })));
  await ok("https://teszt.hu/");
  const q = new URL(sent).searchParams;
  assert.deepEqual([q.get("url"), q.get("strategy"), q.get("category"), q.get("key")], ["https://teszt.hu/", "mobile", "performance", "titok"]);
  const bad = createRun("titok", async () => new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }));
  await assert.rejects(bad("https://teszt.hu/"), (e: Error) => /HTTP 429 Quota exceeded/.test(e.message) && !e.message.includes("titok"));
});
