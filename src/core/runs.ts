import type { Db } from "./db.ts";
import { log } from "./log.ts";

// Does not rethrow: one client/source failing does not stop the rest. True if it succeeded.
export async function withRun(
  db: Db,
  source: string,
  clientId: string,
  targetDate: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const id = db
    .prepare("INSERT INTO runs (source, client_id, target_date, started_at, status) VALUES (?, ?, ?, ?, 'running')")
    .run(source, clientId, targetDate, new Date().toISOString()).lastInsertRowid;
  const ctx = { source, client: clientId, targetDate };
  log("info", "run start", ctx);
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  db.prepare("UPDATE runs SET finished_at = ?, status = ?, error = ? WHERE id = ?").run(
    new Date().toISOString(),
    error === null ? "ok" : "error",
    error,
    id,
  );
  if (error === null) log("info", "run end", ctx);
  else log("error", "run failed", { error, ...ctx });
  return error === null;
}
