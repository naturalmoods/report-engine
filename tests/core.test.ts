import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb, migrate } from "../src/core/db.ts";
import { previousMonth, today } from "../src/core/dates.ts";
import { staleSources } from "../src/core/health.ts";
import { log } from "../src/core/log.ts";
import { withRun } from "../src/core/runs.ts";

const fx = (d: string) => join(import.meta.dirname, "fixtures/clients", d);

test("config: jó fájl betöltődik, example.yaml kimarad", () => {
  const { clients, errors } = loadClients(fx("ok"));
  assert.deepEqual(clients.map((c) => c.id), ["teszt-kft"]);
  assert.deepEqual(errors, []);
});

test("config: hibás mező -> fájlnév és mező a hibában", () => {
  const { clients, errors } = loadClients(fx("bad-field"));
  assert.equal(clients.length, 0);
  assert.match(errors[0].message, /rossz-mezo\.yaml: package:/);
});

test("config: hibás YAML -> fájlnév a hibában", () => {
  assert.match(loadClients(fx("bad-yaml")).errors[0].message, /rossz-yaml\.yaml: érvénytelen YAML/);
});

test("config: egy jó és egy rossz fájl -> a jó ügyfél megvan, a hiba megnevezi a fájlt és a mezőt", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  copyFileSync(join(fx("ok"), "teszt-kft.yaml"), join(dir, "teszt-kft.yaml"));
  copyFileSync(join(fx("bad-field"), "rossz-mezo.yaml"), join(dir, "rossz-mezo.yaml"));
  const { clients, errors } = loadClients(dir);
  assert.deepEqual(clients.map((c) => c.id), ["teszt-kft"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "rossz-mezo.yaml");
  assert.match(errors[0].message, /package:/);
});

test("migráció: kétszer futtatva idempotens", () => {
  const db = openDb(":memory:");
  migrate(db);
  assert.equal(db.prepare("SELECT count(*) FROM schema_migrations").pluck().get(), 3);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
  for (const t of ["metrics", "events", "source_state", "runs", "reports", "uptime_checks"]) assert.ok(tables.includes(t), t);
});

test("withRun: hiba nem dobódik tovább, a runs-ba kerül; siker is rögzül", async () => {
  const db = openDb(":memory:");
  const log = console.log;
  console.log = () => {};
  try {
    const bad = await withRun(db, "gsc", "a", "2026-01-01", async () => {
      throw new Error("boom");
    });
    const good = await withRun(db, "gsc", "b", "2026-01-01", async () => {});
    assert.equal(bad, false);
    assert.equal(good, true);
  } finally {
    console.log = log;
  }
  const rows = db.prepare("SELECT client_id, status, error FROM runs ORDER BY id").all();
  assert.deepEqual(rows, [
    { client_id: "a", status: "error", error: "boom" },
    { client_id: "b", status: "ok", error: null },
  ]);
});

test("health: friss telepítés egészséges, 36 óra után a hiányzó futás elavult; üres registry nem számít", () => {
  const db = openDb(":memory:");
  const [client] = loadClients(fx("ok")).clients;
  const enabled = Object.entries(client.sources).filter(([, c]) => c.enabled).map(([s]) => s);
  assert.ok(enabled.length > 0);
  const now = Date.now();
  assert.deepEqual(staleSources(db, [client], [], now + 99 * 3600e3), []);
  assert.deepEqual(staleSources(db, [client], enabled, now), []);
  assert.equal(staleSources(db, [client], enabled, now + 37 * 3600e3).length, enabled.length);
  const src = enabled[0];
  db.prepare("INSERT INTO runs (source, client_id, target_date, started_at, finished_at, status) VALUES (?, ?, 'x', 'x', ?, 'ok')")
    .run(src, client.id, new Date(now + 36 * 3600e3).toISOString());
  assert.ok(!staleSources(db, [client], enabled, now + 37 * 3600e3).some((s) => s.source === src));
});

test("previousMonth: évforduló", () => {
  assert.equal(previousMonth(new Date(2026, 0, 4)), "2025-12");
  assert.equal(previousMonth(new Date(2026, 9, 4)), "2026-09");
});

test("log: titok értéke nem kerül a sorba", () => {
  process.env.TEST_API_KEY = "szupertitok123";
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    log("error", "hiba szupertitok123 miatt", { client: "a", source: "gsc" });
  } finally {
    console.log = orig;
    delete process.env.TEST_API_KEY;
  }
  assert.ok(!lines[0].includes("szupertitok123"));
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ["client", "level", "msg", "source", "time"]);
});

test("dates: addDays/addMonths/lastDayOf", async () => {
  const d = await import("../src/core/dates.ts");
  assert.equal(d.addDays("2026-03-02", -3), "2026-02-27");
  assert.equal(d.addMonths("2026-02", -15), "2024-11");
  assert.equal(d.lastDayOf("2024-02"), "2024-02-29");
});

test("dates: today/previousMonth Budapest szerint, a folyamat TZ-jétől függetlenül", () => {
  const t = new Date("2026-09-30T23:30:00Z"); // already October 1 in Budapest.
  assert.equal(today(t), "2026-10-01");
  assert.equal(previousMonth(t), "2026-09");
});
