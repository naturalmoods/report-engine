import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

export function migrate(db: Db, dir = MIGRATIONS): void {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  // BEGIN IMMEDIATE: reading "what is applied" is also under the lock, so two concurrent starts do not apply the same migration twice.
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(db.prepare("SELECT name FROM schema_migrations").pluck().all() as string[]);
    for (const f of files.filter((f) => !done.has(f))) {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    }
  }).immediate();
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000"); // a concurrent writer waits instead of failing with SQLITE_BUSY
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
