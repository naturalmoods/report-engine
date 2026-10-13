import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import Database from "better-sqlite3";
import type { BackupStore } from "../delivery/r2.ts";
import { addDays, addMonths } from "./dates.ts";
import type { Db } from "./db.ts";

// One backup per day: a rerun writes to the same key (overwrites).
const NAME = /^report-engine-(\d{4}-\d{2}-\d{2})\.db\.gz$/;
export const backupKey = (day: string) => `report-engine-${day}.db.gz`;

// Retention on a given day: keep (1) every backup of the last 30 days (today-29 .. today), (2) the FIRST backup of each of the last 12 calendar
// months (including the current one), however old the day it was made on; (3) objects with a future date
// (clock skew) or not matching the name pattern are never deleted. The return value is the keys to delete.
export function expired(keys: string[], today: string): string[] {
  const days = keys.flatMap((k) => NAME.exec(k)?.[1] ?? []).sort();
  const firsts = new Set(days.filter((d, i) => i === 0 || days[i - 1].slice(0, 7) !== d.slice(0, 7)));
  const oldest = addDays(today, -29);
  const oldestMonth = addMonths(today.slice(0, 7), -11);
  return days
    .filter((d) => d < oldest && !(firsts.has(d) && d.slice(0, 7) >= oldestMonth))
    .map(backupKey);
}

// Online backup (db.backup: WAL-safe, usable while the connection is running) → gzip → upload → delete old ones.
// Temp files live under os.tmpdir() (/tmp in the container, writable for the node user) and are deleted at the end.
export async function runBackup(db: Db, store: BackupStore, day: string): Promise<{ key: string; deleted: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "report-engine-backup-"));
  try {
    const raw = join(dir, "snapshot.db");
    await db.backup(raw);
    const gz = `${raw}.gz`;
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(gz));
    const key = backupKey(day);
    await store.put(key, gz);
    const deleted = expired(await store.list(), day);
    for (const k of deleted) await store.remove(k);
    return { key, deleted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Restore from a (manually downloaded) .db.gz file. An existing database is overwritten only with force.
// Decompression goes next to the target (same filesystem, so the rename is atomic); integrity_check before the rename.
export async function restoreBackup(file: string, target: string, force: boolean): Promise<void> {
  if (existsSync(target) && !force) throw new Error(`${target} már létezik; felülíráshoz: --force`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.restore-${process.pid}`;
  const cleanup = () => [tmp, `${tmp}-wal`, `${tmp}-shm`].forEach((f) => rmSync(f, { force: true }));
  try {
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(tmp));
    const check = new Database(tmp);
    try {
      const r = check.pragma("integrity_check", { simple: true });
      if (r !== "ok") throw new Error(`a mentés sérült (integrity_check: ${r})`);
    } finally {
      check.close();
    }
    // The leftover -wal/-shm of the verification open and the target's old -wal/-shm must also be removed: a WAL that does not
    // belong to the new database can cause corruption.
    for (const f of [`${tmp}-wal`, `${tmp}-shm`, `${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
    renameSync(tmp, target);
  } finally {
    cleanup();
  }
}
