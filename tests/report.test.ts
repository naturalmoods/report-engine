import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { addDays, lastDayOf } from "../src/core/dates.ts";
import { openDb, type Db } from "../src/core/db.ts";
import { loadEnv } from "../src/core/env.ts";
import { esc, html, pctChange } from "../src/report/html.ts";
import { generateReport, renderReport } from "../src/report/index.ts";
import { addManual } from "../src/sources/worklog/index.ts";

// Made-up client (tests/fixtures/clients/ok/teszt-kft.yaml), July–September 2026; the report is for September.
// Updating the snapshot: node --test --test-update-snapshots tests/report.test.ts
const [client] = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients;
const SNAPSHOT = join(import.meta.dirname, "fixtures/report/teszt-kft-2026-09.html");
const NOW = new Date("2026-10-04T05:00:00Z");
const EVIL = `<script>alert("x")</script>`;
const months = ["2026-07", "2026-08", "2026-09"];

function seed(db: Db) {
  const metric = db.prepare("INSERT INTO metrics (client_id, source, metric, dimension, period, date, value) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const event = db.prepare("INSERT INTO events (client_id, source, external_id, type, ts, title, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  months.forEach((month, mi) => {
    for (let day = `${month}-01`, i = 0; day <= lastDayOf(month); day = addDays(day, 1), i++) {
      // GSC daily: less on weekends, traffic growing monthly; position improves.
      const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
      const clicks = Math.round((40 + mi * 6 + (i % 7) * 2) * (weekend ? 0.6 : 1));
      const impressions = clicks * 28 + (i % 5) * 37;
      for (const [k, v] of Object.entries({ clicks, impressions, ctr: clicks / impressions, position: 14.2 - mi * 0.8 + (i % 3) * 0.3 }))
        metric.run(client.id, "gsc", k, "", "day", day, v);
      // Uptime: client-level daily row (dimension ''); no measurement on Sept 20 (gap in the chart).
      if (day === "2026-09-20") continue;
      metric.run(client.id, "uptime", "checks", "", "day", day, 576);
      metric.run(client.id, "uptime", "uptime_pct", "", "day", day, day === "2026-09-12" ? 98.9 : day === "2026-09-30" ? 99.65 : 100);
      metric.run(client.id, "uptime", "avg_response_ms", "", "day", day, 310 + (i % 6) * 22 - mi * 15);
      metric.run(client.id, "uptime", "p95_response_ms", "", "day", day, 620 + (i % 6) * 30);
    }
    const tops: [string, string, number, number, number][] = [
      ["query", "teszt kft", 210 + mi * 20, 2100, 1.4],
      ["query", "teszt kft kapcsolat", 80 - mi * 15, 900, 2.1],
      ["query", "ipari tesztelés budapest", 30 + mi * 25, 3200, 7.8],
      ["query", EVIL, 12, 140, 9.3],
      ["query", "hogyan működik az ipari tesztelés", 4 + mi * 3, 260 + mi * 120, 8.4],
      ["page", "https://teszt.hu/", 300 + mi * 30, 4000, 2.2],
      ["page", "https://teszt.hu/szolgaltatasok/ipari-teszteles/", 90 + mi * 20, 3500, 6.4],
      ["page", `https://teszt.hu/blog/?q="><img src=x onerror=alert(1)>`, 15, 400, 11.2],
    ];
    if (mi === 2) tops.push(["query", "tesztlabor árak", 22, 610, 5.5]);
    for (const [prefix, key, clicks, impressions, position] of tops)
      for (const [k, v] of Object.entries({ clicks, impressions, position })) metric.run(client.id, "gsc", k, `${prefix}:${key}`, "month", month, v);
  });

  // Downtimes: one ended in August (not visible), one in September, and one still ongoing at the end of the month.
  const down = (url: string, start: string, end: string | null) => {
    event.run(client.id, "uptime", `downtime_start:${url}:${start}`, "downtime_start", start, `Leállás: ${url}`, JSON.stringify({ url, start }));
    if (end) {
      const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
      event.run(client.id, "uptime", `downtime_end:${url}:${start}`, "downtime_end", end, `Helyreállt: ${url}`, JSON.stringify({ url, start, end, seconds }));
    }
  };
  down("https://teszt.hu/", "2026-08-14T09:00:00.000Z", "2026-08-14T09:20:00.000Z");
  down("https://teszt.hu/kapcsolat/", "2026-09-12T08:05:00.000Z", "2026-09-12T08:45:00.000Z");
  down("https://teszt.hu/", "2026-09-30T20:40:00.000Z", "2026-10-01T06:10:00.000Z"); // Sept 30 22:40 – Oct 1 in Budapest.

  const commit = (type: string, ts: string, title: string, n: number) =>
    event.run(client.id, "worklog", `naturalmoods/teszt-hu@${type}${n}`, type, ts, title, JSON.stringify({ repo: "naturalmoods/teszt-hu", sha: `${type}${n}`, url: "https://github.com/x", author: "Dev" }));
  commit("commit", "2026-08-20T10:00:00.000Z", "Augusztusi commit, nem látszik", 0);
  commit("commit", "2026-09-02T09:12:00.000Z", "Kapcsolati űrlap: spamszűrés bekapcsolása", 1);
  commit("commit", "2026-09-09T13:40:00.000Z", "Szolgáltatásoldal: új referenciák", 2);
  commit("commit", "2026-09-18T07:05:00.000Z", `<img src=x onerror=alert(1)> & "idézet"`, 3);
  commit("commit", "2026-09-30T22:30:00.000Z", "Ez már október 1. Budapesten, nem látszik", 4);
  commit("merge", "2026-09-09T14:00:00.000Z", "Merge pull request #12 from naturalmoods/referenciak", 5);
  for (let n = 0; n < 4; n++) commit("bot", `2026-09-${String(10 + n).padStart(2, "0")}T03:00:00.000Z`, "Bump some-dependency", 10 + n);
  addManual(db, client.id, "WordPress- és bővítményfrissítés, biztonsági mentés ellenőrzése", "2026-09-05", 45);
  addManual(db, client.id, "Ügyféltalálkozó a novemberi kampányról", "2026-09-22", 60);
  addManual(db, client.id, "DNS-rekord javítása", "2026-09-25");
}

const tmp = () => mkdtempSync(join(tmpdir(), "report-"));

test("riport: 3 hónapnyi fixture, szeptemberi riport snapshot; minden adat escape-elve; draft a reports táblában", async (t) => {
  const db = openDb(":memory:");
  seed(db);
  const path = await generateReport({ db, env: { BRAND_NAME: "Példa Stúdió" } }, client, "2026-09", { outDir: tmp(), now: NOW });
  assert.match(path, /teszt-kft\/2026-09\/index\.html$/);
  const page = readFileSync(path, "utf8");
  t.assert.fileSnapshot(page, SNAPSHOT, { serializers: [(v) => v] });

  assert.ok(!page.includes("<script") && !page.includes("<img"), "nyers HTML az adatból");
  assert.ok(page.includes(esc(EVIL)) && page.includes("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;idézet&quot;"));
  assert.ok(!page.includes("Augusztusi commit") && !page.includes("Ez már október"));
  assert.match(page, /a hónap végén még tartott/);
  assert.match(page, /1 összevonás \(merge\) és 4 automatikus frissítés/);
  assert.ok(!page.includes("Bump some-dependency"), "a bot-commitok csak számként");
  assert.ok(!page.includes("AI segítségével") && !page.includes('class="ai"'), "AI-blokk és -jelölés csak AI-szövegnél");
  assert.ok(!page.includes('class="preview"'), "az ügyfélváltozatban nincs előnézeti sáv");
  const preview = readFileSync(path.replace("index.html", "preview.html"), "utf8");
  assert.match(preview, /class="preview"[\s\S]*AI-szöveg nincs: a riport --live nélkül készült/);
  assert.deepEqual(db.prepare("SELECT client_id, month, status, ai_status FROM reports").all(), [
    { client_id: "teszt-kft", month: "2026-09", status: "draft", ai_status: "skipped" },
  ]);
});

test("riport: adat nélkül is elkészül, minden szekcióban magyarázó mondattal, grafikon nélkül", async () => {
  const db = openDb(":memory:");
  const path = await generateReport({ db, env: {} }, client, "2026-09", { outDir: tmp(), now: NOW });
  const page = readFileSync(path, "utf8");
  for (const s of ["nincs Search Console-adat", "nincs elérhetőségi mérés", "nincs rögzített munka"]) assert.ok(page.includes(s), s);
  assert.ok(!page.includes("<svg"));
});

test("riport: kevés adatnál mondat a grafikon helyett; kikapcsolt forrásnak nincs szekciója", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO metrics VALUES ('teszt-kft', 'uptime', ?, '', 'day', '2026-09-03', ?)").run("checks", 10);
  db.prepare("INSERT INTO metrics VALUES ('teszt-kft', 'uptime', ?, '', 'day', '2026-09-03', ?)").run("uptime_pct", 100);
  const only = { ...client, sources: { uptime: client.sources.uptime } };
  const page = readFileSync(await generateReport({ db, env: {} }, only, "2026-09", { outDir: tmp(), now: NOW }), "utf8");
  assert.match(page, /Átlagos napi válaszidő: a grafikonhoz nincs elég napi adat/);
  assert.match(page, /A hónapban nem volt leállás/);
  assert.ok(!page.includes("Keresési teljesítmény") && !page.includes("Elvégzett munka"));
  // Without BRAND_NAME no agency name.
  assert.ok(!page.includes('class="brand"') && page.includes("<p>Készült · "));
});

test("riport: a draft felülírható, jóváhagyott/kiküldött nem (és a fájl sem íródik)", async () => {
  const db = openDb(":memory:");
  const outDir = tmp();
  const gen = () => generateReport({ db, env: {} }, client, "2026-09", { outDir, now: NOW });
  const path = await gen();
  await gen();
  assert.equal(db.prepare("SELECT count(*) FROM reports").pluck().get(), 1);
  for (const status of ["approved", "sent"]) {
    db.prepare("UPDATE reports SET status = ?").run(status);
    writeFileSync(path, "jelölő");
    await assert.rejects(gen(), /nem írható felül/);
    assert.equal(readFileSync(path, "utf8"), "jelölő");
    assert.equal(db.prepare("SELECT status FROM reports").pluck().get(), status);
  }
});

test("riport: AI-jelölés a láblécben csak AI-szöveggel; formázás és escape", () => {
  const ai = { summary: "Összefoglaló.", workItems: [], suggestions: [] };
  assert.match(renderReport(client, "2026-09", [], { now: NOW, ai }), /Az összefoglalót AI segítségével készítettük, emberi jóváhagyással\./);
  assert.deepEqual([pctChange(0.1234), pctChange(-0.04), pctChange(0.00001)], ["+12,3%", "−4,0%", "0,0%"]);
  assert.equal(html`<a title="${`"><b>`}">${["<i>", html`<u>`]}</a>`.__html, `<a title="&quot;&gt;&lt;b&gt;">&lt;i&gt;<u></a>`);
  assert.doesNotThrow(() => loadEnv("report", {}));
});

test("riport: generálás közbeni jóváhagyás nem íródik vissza draftra, a fájl sem íródik", async () => {
  const db = openDb(":memory:");
  const outDir = tmp();
  const path = await generateReport({ db, env: {} }, client, "2026-09", { outDir, now: NOW });
  writeFileSync(path, "jelölő");
  const llm = { generate: async () => (db.prepare("UPDATE reports SET status = 'approved'").run(), "nem json") }; // the approve comes during the long LLM call
  await assert.rejects(generateReport({ db, env: {} }, client, "2026-09", { outDir, now: NOW, llm }), /közben jóváhagyásra került/);
  assert.equal(db.prepare("SELECT status FROM reports").pluck().get(), "approved");
  assert.equal(readFileSync(path, "utf8"), "jelölő");
});
