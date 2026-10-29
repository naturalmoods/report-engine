import { parseArgs } from "node:util";
import { loadClients } from "../core/config.ts";
import { addMonths, budapestDay, previousMonth, today } from "../core/dates.ts";
import { openDb, type Db } from "../core/db.ts";
import { loadEnv, sourceEnv } from "../core/env.ts";
import { staleSources } from "../core/health.ts";
import { log, setCommand } from "../core/log.ts";
import { withRun } from "../core/runs.ts";
import { runUptime } from "../sources/uptime/index.ts";
import { addManual } from "../sources/worklog/index.ts";
import { registry } from "../sources/registry.ts";
import { anthropicLlm } from "../report/ai.ts";
import { generateReport } from "../report/index.ts";
import { postalMailer } from "../delivery/email.ts";
import { approve, send, sendPreview, type Deps } from "../delivery/flow.ts";
import { r2Backups, r2Storage } from "../delivery/r2.ts";
import { restoreBackup, runBackup } from "../core/backup.ts";
import { alertAiAccess, alertDowntime, alertFailures, alertStale, baseline, crashMessage, draftsMessage, maxEventId } from "../notify/alerts.ts";
import { notify } from "../notify/telegram.ts";

// Bad config file: a runs error (source 'config', client_id = file name), so the hourly throttled aggregate alert carries it;
// the valid clients keep running. Called after baseline(), before alertFailures.
async function recordConfigErrors(db: Db, errors: { file: string; message: string }[]): Promise<boolean> {
  let failed = false;
  for (const e of errors) failed = !(await withRun(db, "config", e.file, "-", async () => { throw new Error(e.message); })) || failed;
  return failed;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    health: { type: "boolean" },
    month: { type: "string" },
    client: { type: "string" },
    day: { type: "string" },
    from: { type: "string" },
    source: { type: "string" },
    date: { type: "string" },
    minutes: { type: "string" },
    "dry-run": { type: "boolean" },
    live: { type: "boolean" },
    force: { type: "boolean" },
  },
});
const [command] = positionals;
if (command) setCommand(command);

// A command-level crash of scheduled commands (missing env, bad config, DB error, ...) happens even before runs rows are created,
// so the runs-based alert does not see it there: this handler sends a message, then exits. The text goes through
// the scrubber (notify), secret values must not get into it.
if (command && ["collect", "collect-monthly", "uptime", "report", "backup"].includes(command)) {
  process.on("uncaughtException", async (e) => {
    console.error(e);
    await notify(crashMessage(command, e));
    process.exit(1);
  });
}

if (command === "status") {
  const env = loadEnv("status");
  const { clients, errors } = loadClients(env.CONFIG_DIR);
  const db = openDb(env.DATABASE_PATH);
  if (values.health) {
    const stale = staleSources(db, clients, registry.map((s) => s.id));
    for (const s of stale) log("error", "elavult forrás: az utolsó sikeres futás több mint 36 órás", s);
    for (const e of errors) log("error", "érvénytelen config-fájl", { file: e.file, message: e.message });
    process.exitCode = stale.length || errors.length ? 1 : 0;
  } else {
    for (const e of errors) console.log(`HIBÁS CONFIG: ${e.message}`);
    const last = db.prepare(
      "SELECT max(finished_at) FROM runs WHERE client_id = ? AND source = ? AND status = 'ok'",
    ).pluck();
    for (const c of clients) {
      console.log(`${c.id} (${c.name})${c.enabled ? "" : " [letiltva]"}`);
      for (const [source, cfg] of Object.entries(c.sources)) {
        if (!cfg.enabled) continue;
        console.log(`  ${source}: ${last.get(c.id, source) ?? "még nem futott"}`);
        if (source === "worklog") {
          const m = db.prepare("SELECT ts, title, meta_json FROM events WHERE client_id = ? AND source = 'worklog' AND type = 'manual' ORDER BY ts DESC, id DESC LIMIT 1").get(c.id) as { ts: string; title: string; meta_json: string } | undefined;
          const min = m && JSON.parse(m.meta_json).minutes;
          console.log(`  worklog utolsó kézi bejegyzés: ${m ? `${budapestDay(m.ts)} ${m.title}${min ? ` (${min} perc)` : ""}` : "nincs"}`);
        }
      }
    }
  }
} else if (command === "collect" || command === "collect-monthly" || command === "backfill") {
  const dryRun = command === "backfill" && !!values["dry-run"];
  const env = loadEnv(command);
  const { clients: all, errors } = loadClients(env.CONFIG_DIR);
  const only = positionals[1] ?? values.client;
  if (only && !all.some((c) => c.id === only)) throw new Error(`Ismeretlen ügyfél: ${only}`);
  const clients = only ? all.filter((c) => c.id === only) : all.filter((c) => c.enabled);
  const db = openDb(env.DATABASE_PATH);
  const since = baseline(db), sinceEvent = maxEventId(db);
  let failed = !dryRun && (await recordConfigErrors(db, errors));
  const month = values.month ?? previousMonth();
  const from = values.from ?? addMonths(today().slice(0, 7), -15);
  for (const [name, v, re] of [["month", month, /^\d{4}-(0[1-9]|1[0-2])$/], ["day", values.day ?? today(), /^\d{4}-\d{2}-\d{2}$/], ["from", from, /^\d{4}-(0[1-9]|1[0-2])$/]] as const) {
    if (!re.test(v)) throw new Error(`Érvénytelen --${name}: ${v}`);
  }
  // Every client × source runs in its own withRun, one failure does not stop the rest.
  for (const client of clients) {
    for (const source of registry) {
      if (!client.sources[source.id as keyof typeof client.sources]?.enabled) continue;
      if (values.source && values.source !== source.id) continue;
      const ctx = { db, env, dryRun };
      const day = values.day ?? source.defaultDay();
      const [fn, target] =
        command === "collect" ? [() => source.collect(ctx, client, day), day]
        : command === "collect-monthly" ? [source.collectMonthly && (() => source.collectMonthly!(ctx, client, month)), month]
        : [source.backfill && (() => source.backfill!(ctx, client, from)), from];
      if (!fn) continue;
      if (dryRun) await fn();
      else failed = !(await withRun(db, source.id, client.id, target as string, fn)) || failed;
    }
  }
  if (!dryRun && command !== "backfill") {
    await alertFailures(db, command, since);
    if (command === "collect") {
      await alertStale(db, all.filter((c) => c.enabled));
      await alertAiAccess(db, sinceEvent);
    }
  }
  process.exitCode = failed ? 1 : 0;
} else if (command === "log") {
  const [, clientId, text] = positionals;
  const env = loadEnv("log");
  const client = loadClients(env.CONFIG_DIR).clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Ismeretlen ügyfél: ${clientId ?? "(hiányzik)"}. Használat: log <ügyfél> "szöveg" [--date YYYY-MM-DD] [--minutes N]`);
  if (!text?.trim()) throw new Error("A bejegyzés szövege üres");
  const date = values.date ?? budapestDay(new Date().toISOString());
  // The date must be a real calendar day (2026-02-31 is not).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`Érvénytelen --date: ${date}`);
  const minutes = values.minutes === undefined ? undefined : Number(values.minutes);
  if (minutes !== undefined && !(Number.isInteger(minutes) && minutes > 0)) throw new Error(`Érvénytelen --minutes: ${values.minutes}`);
  addManual(openDb(env.DATABASE_PATH), client.id, text.trim(), date, minutes);
  console.log(`${client.id}: bejegyzés rögzítve (${date}${minutes ? `, ${minutes} perc` : ""})`);
} else if (command === "uptime") {
  const env = loadEnv("uptime");
  const db = openDb(env.DATABASE_PATH);
  const since = baseline(db), sinceEvent = maxEventId(db);
  const { clients, errors } = loadClients(env.CONFIG_DIR);
  const configFailed = await recordConfigErrors(db, errors);
  const upOk = await runUptime(db, clients.filter((c) => c.enabled));
  process.exitCode = upOk && !configFailed ? 0 : 1;
  await alertFailures(db, "uptime", since); // the same error at most once per hour
  await alertDowntime(db, sinceEvent); // start/end of an outage: on state change, once
  // Dead-man ping only on a successful round; a failure does not fail the command, the URL (and the error text) does not go into the log.
  if (upOk && env.HEALTHCHECK_URL)
    await fetch(env.HEALTHCHECK_URL, { signal: AbortSignal.timeout(5000) }).then((r) => r.body?.cancel(), () => log("warn", "healthcheck-ping nem ment el"));
} else if (command === "report") {
  // cli report [YYYY-MM] [--client X] [--live]; without a month (cron) the previous month, without a client every enabled client with a monthly report.
  // --live: AI text via the Anthropic API; only then are ANTHROPIC_API_KEY and LLM_MODEL required (missing: error before
  // anything is produced). Without --live there is no API call, the report is made without AI text (ai_status = skipped). The cron runs with --live.
  const env = loadEnv("report");
  const llm = values.live ? anthropicLlm(sourceEnv("ai")) : undefined;
  const month = positionals[1] ?? values.month ?? previousMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Érvénytelen hónap: ${month}`);
  const { clients: all, errors } = loadClients(env.CONFIG_DIR);
  if (values.client && !all.some((c) => c.id === values.client)) throw new Error(`Ismeretlen ügyfél: ${values.client}`);
  const clients = values.client ? all.filter((c) => c.id === values.client) : all.filter((c) => c.enabled && c.report?.monthly !== false);
  const db = openDb(env.DATABASE_PATH);
  const since = baseline(db);
  let failed = await recordConfigErrors(db, errors), baseUrl: string | undefined;
  const built = [];
  for (const client of clients) {
    const ok = await withRun(db, "report", client.id, month, async () => {
      const path = await generateReport({ db, env }, client, month, { outDir: env.OUT_DIR, now: new Date(), llm });
      log("info", "riport-draft elkészült", { client: client.id, month, path });
    });
    failed = !ok || failed;
    if (!ok) continue;
    built.push(client);
    // Preview of the draft: skipped (with a warning) on a missing POSTAL/R2 variable, because the report is already done and the cron must not fail on this.
    // A send failure is a separate run ("preview"), the report's run stays ok; exit code 1. --dry-run: only prints.
    let pdeps: Deps | undefined, previewTo = "";
    try {
      const e = loadEnv("preview");
      pdeps = { db, outDir: env.OUT_DIR, store: r2Storage(e), mailer: postalMailer(e), from: e.EMAIL_FROM, baseUrl: e.REPORT_BASE_URL, dryRun: !!values["dry-run"], say: console.log };
      previewTo = e.EMAIL_PREVIEW_TO;
      baseUrl = e.REPORT_BASE_URL;
    } catch (e) {
      log("warn", "előnézet kihagyva", { client: client.id, month, reason: (e as Error).message });
    }
    if (pdeps) {
      const d = pdeps;
      failed = !(await withRun(db, "preview", client.id, month, async () => void log("info", "előnézet kiküldve", { client: client.id, month, url: await sendPreview(d, client, month, previewTo) }))) || failed;
    }
  }
  if (!values["dry-run"]) {
    await alertFailures(db, "report", since);
    const drafts = draftsMessage(db, built, month, baseUrl);
    if (drafts) await notify(drafts);
  }
  process.exitCode = failed ? 1 : 0;
} else if (command === "approve" || command === "send") {
  // cli approve|send <client> [YYYY-MM] [--dry-run]; without a month the previous month. send in dry-run does not require R2/Postal variables.
  const [, clientId] = positionals;
  const month = positionals[2] ?? values.month ?? previousMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Érvénytelen hónap: ${month}`);
  const dryRun = !!values["dry-run"];
  const env = loadEnv(command === "send" && !dryRun ? "send" : "approve");
  const client = loadClients(env.CONFIG_DIR).clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Ismeretlen ügyfél: ${clientId ?? "(hiányzik)"}. Használat: ${command} <ügyfél> [YYYY-MM] [--dry-run]`);
  const db = openDb(env.DATABASE_PATH);
  if (command === "approve") {
    approve(db, client.id, month, dryRun);
    console.log(`${dryRun ? "dry-run: " : ""}${client.id} ${month}: jóváhagyva${dryRun ? " lenne" : ""}`);
  } else {
    const d: Deps = dryRun
      ? { db, outDir: env.OUT_DIR, store: undefined!, mailer: undefined!, from: "", baseUrl: process.env.REPORT_BASE_URL ?? "<REPORT_BASE_URL>", dryRun, say: console.log }
      : { db, outDir: env.OUT_DIR, store: r2Storage(env), mailer: postalMailer(env), from: env.EMAIL_FROM, baseUrl: env.REPORT_BASE_URL };
    const r = await send(d, client, month);
    if (r === "already-sent") console.log(`${client.id} ${month}: már ki van küldve, nem küldöm újra`);
    else if (!dryRun) console.log(`${client.id} ${month}: kiküldve ${client.recipients.length} címzettnek`);
  }
} else if (command === "backup") {
  // cli backup: SQLite online backup → gzip → R2_BUCKET_BACKUPS/report-engine-YYYY-MM-DD.db.gz, then deletion per the retention rule.
  const env = loadEnv("backup");
  const { key, deleted } = await runBackup(openDb(env.DATABASE_PATH), r2Backups(env), today());
  log("info", "mentés kész", { key, deleted: deleted.length });
} else if (command === "restore") {
  // cli restore <file.db.gz> [--force]: onto an empty DATABASE_PATH; an existing database is overwritten only with --force.
  const [, file] = positionals;
  if (!file) throw new Error("Használat: restore <fájl.db.gz> [--force]");
  const env = loadEnv("restore");
  await restoreBackup(file, env.DATABASE_PATH, !!values.force);
  console.log(`${env.DATABASE_PATH}: visszaállítva (${file})`);
} else {
  console.error(`Használat: cli <${["status", "collect", "collect-monthly", "backfill", "uptime", "log", "report", "approve", "send", "backup", "restore"].join("|")}>`);
  process.exitCode = 1;
}
