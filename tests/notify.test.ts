import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { backupKey, expired, restoreBackup, runBackup } from "../src/core/backup.ts";
import { openDb } from "../src/core/db.ts";
import type { BackupStore } from "../src/delivery/r2.ts";
import { alertDowntime, alertFailures, alertStale, baseline, draftsMessage } from "../src/notify/alerts.ts";
import { clip, notify } from "../src/notify/telegram.ts";

const ENV = { TELEGRAM_BOT_TOKEN: "tok-123456", TELEGRAM_CHAT_ID: "42" };
const sent: any[] = [];
const fake = (async (url: string, init: any) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as any;
const deps = { env: ENV, fetch: fake };
const run = (db: any, client: string, source: string, status: string, error: string | null = null, fin = "2026-10-12T05:00:00Z") =>
  db.prepare("INSERT INTO runs (source, client_id, target_date, started_at, finished_at, status, error) VALUES (?, ?, 'd', ?, ?, ?, ?)").run(source, client, fin, fin, status, error);

test("telegram: üzenet a chat_id-ra, hosszvágás, hiányzó változónál nem dob", async () => {
  sent.length = 0;
  assert.equal(await notify("szia", deps), true);
  assert.equal(sent[0].body.chat_id, "42");
  assert.ok(sent[0].url.includes("/bottok-123456/sendMessage"));
  assert.equal([...clip("é".repeat(5000))].length, 4000);
  assert.equal(await notify("x", { env: {}, fetch: fake }), false);
  assert.equal(sent.length, 1);
  assert.equal(await notify("x", { env: ENV, fetch: (async () => ({ ok: false, status: 500 })) as any }), false);
});

test("riasztás: egy összesített üzenet, csak az ebben a parancsban keletkezett hibák, első sor", async () => {
  sent.length = 0;
  const db = openDb(":memory:");
  run(db, "régi", "gsc", "error", "régi hiba");
  const since = baseline(db);
  run(db, "a-kft", "gsc", "error", "403 Forbidden\nstack...");
  run(db, "b-kft", "uptime", "error", "időtúllépés");
  run(db, "c-kft", "gsc", "ok");
  await alertFailures(db, "collect", since, deps);
  assert.equal(sent.length, 1);
  const t: string = sent[0].body.text;
  assert.match(t, /2 hibás futás/);
  assert.ok(t.includes("a-kft / gsc: 403 Forbidden") && t.includes("b-kft / uptime: időtúllépés"));
  assert.ok(!t.includes("régi") && !t.includes("stack"));
  // no new error -> no message
  await alertFailures(db, "collect", baseline(db), deps);
  assert.equal(sent.length, 1);
});

test("riasztás: ugyanaz a hiba óránként legfeljebb egyszer (uptime 5 percenként)", async () => {
  sent.length = 0;
  const db = openDb(":memory:");
  const t0 = Date.parse("2026-10-12T10:00:00Z");
  const round = async (min: number) => {
    const s = baseline(db);
    run(db, "a-kft", "uptime", "error", "hálózati hiba");
    await alertFailures(db, "uptime", s, { ...deps, now: t0 + min * 60_000 });
  };
  await round(0);
  await round(5);
  await round(55);
  assert.equal(sent.length, 1);
  await round(60);
  assert.equal(sent.length, 2);
  // a failed send is not recorded: the next round tries again
  const s = baseline(db);
  run(db, "x", "uptime", "error", "másik hiba");
  await alertFailures(db, "uptime", s, { env: ENV, fetch: (async () => ({ ok: false, status: 500 })) as any, now: t0 });
  await alertFailures(db, "uptime", s, { ...deps, now: t0 });
  assert.equal(sent.length, 3);
});

test("dead-man és leállás-üzenet, draft-üzenet előnézeti linkkel", async () => {
  sent.length = 0;
  const db = openDb(":memory:");
  const c = { id: "a-kft", name: "A Kft", enabled: true, sources: { gsc: { enabled: true } } } as any;
  db.prepare("UPDATE schema_migrations SET applied_at = '2020-01-01T00:00:00Z'").run();
  await alertStale(db, [c], deps);
  assert.match(sent[0].body.text, /a-kft \/ gsc \(utolsó siker: soha\)/);

  sent.length = 0;
  db.prepare("INSERT INTO events (client_id, source, external_id, type, ts, title) VALUES ('a-kft', 'uptime', 'e1', 'downtime_start', 't', 'Leállás: https://a.hu/')").run();
  await alertDowntime(db, 0, deps);
  assert.ok(sent[0].body.text.includes("a-kft: Leállás: https://a.hu/"));

  db.prepare("INSERT INTO reports (client_id, month, status) VALUES ('a-kft', '2026-09', 'draft')").run();
  db.prepare("INSERT INTO source_state (client_id, source, key, value) VALUES ('a-kft', 'delivery', 'preview:2026-09', 'RND')").run();
  const m = draftsMessage(db, [c, { ...c, id: "b", name: "B" }], "2026-09", "https://r.example.hu/");
  assert.ok(m!.includes("A Kft: https://r.example.hu/preview/RND/index.html") && !m!.includes("B:"));
  assert.equal(draftsMessage(db, [{ ...c, id: "b" }], "2026-09", undefined), undefined);
});

const names = (days: string[]) => days.map(backupKey);
test("megőrzés: 30 napi + 12 havi, a többi törlendő; idegen név és jövő érintetlen", () => {
  const today = "2026-10-12";
  const keys = [
    ...names(["2025-09-15", "2025-09-20", "2025-10-03", "2025-10-04", "2025-11-30", "2026-01-31", "2026-02-02", "2026-02-03"]),
    ...names(["2026-09-12", "2026-09-13", "2026-09-14", "2026-10-11", "2026-10-12", "2026-10-13"]), // 09-12 is the 31st day, 10-13 is future
    "report-engine-latest.db.gz", "masik/report-engine-2020-01-01.db.gz",
  ];
  // 2025-09, 2025-10: outside the 12-month window (2025-11..2026-10); 2026-02-03: not the first of its month and not daily.
  // Kept: 2025-11-30, 2026-01-31, 2026-02-02 (monthly firsts), 2026-09-12 (first backup of September), the daily window, future, foreign names.
  assert.deepEqual(expired(keys, today).sort(), names(["2025-09-15", "2025-09-20", "2025-10-03", "2025-10-04", "2026-02-03"]));
  assert.deepEqual(expired(names(["2026-10-12"]), today), []);
});

test("mentés -> visszaállítás körút ideiglenes adatbázison; --force nélkül nem ír felül; megőrzés fut", async () => {
  const dir = mkdtempSync(join(tmpdir(), "re-test-"));
  const src = join(dir, "src.db");
  const db = openDb(src);
  db.prepare("INSERT INTO source_state (client_id, source, key, value) VALUES ('a', 's', 'k', 'ÉRTÉK')").run();
  const files = new Map<string, Buffer>();
  const store: BackupStore = {
    put: async (k, f) => void files.set(k, readFileSync(f)),
    list: async () => [...files.keys()],
    remove: async (k) => void files.delete(k),
  };
  files.set(backupKey("2025-01-05"), Buffer.alloc(0));
  files.set(backupKey("2025-01-06"), Buffer.alloc(0));
  const r = await runBackup(db, store, "2026-10-12");
  assert.equal(r.key, "report-engine-2026-10-12.db.gz");
  assert.deepEqual(r.deleted, [backupKey("2025-01-05"), backupKey("2025-01-06")]); // older than 12 months
  const gz = join(dir, "b.db.gz");
  writeFileSync(gz, files.get(r.key)!);
  assert.equal(gunzipSync(files.get(r.key)!).subarray(0, 15).toString(), "SQLite format 3");

  const target = join(dir, "data", "new.db");
  await restoreBackup(gz, target, false); // goes to an empty target
  const back = new Database(target);
  assert.equal(back.prepare("SELECT value FROM source_state WHERE key = 'k'").pluck().get(), "ÉRTÉK");
  back.close();
  await assert.rejects(restoreBackup(gz, target, false), /--force/);
  writeFileSync(`${target}-wal`, "régi maradék");
  await restoreBackup(gz, target, true);
  assert.ok(!existsSync(`${target}-wal`));
  assert.deepEqual(readdirSync(join(dir, "data")), ["new.db"]); // no temporary leftover
  writeFileSync(join(dir, "rossz.db.gz"), "nem gzip");
  await assert.rejects(restoreBackup(join(dir, "rossz.db.gz"), join(dir, "data", "x.db"), false));
  assert.ok(!existsSync(join(dir, "data", "x.db")) && readdirSync(join(dir, "data")).length === 1);
});
