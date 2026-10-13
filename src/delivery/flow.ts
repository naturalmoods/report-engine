import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "../core/config.ts";
import type { Db } from "../core/db.ts";
import { withUrl, type EmailContent } from "../report/email.ts";
import type { Mailer } from "./email.ts";
import type { Storage } from "./r2.ts";

// State machine: (none) → draft → approved → sent. The draft is created (and overwritten while draft) by report.
export interface Deps {
  db: Db;
  outDir: string;
  store: Storage;
  mailer: Mailer;
  from: string;
  baseUrl: string; // REPORT_BASE_URL
  dryRun?: boolean;
  say?: (line: string) => void; // dry-run output
}

const CACHE = "public, max-age=300";
const stateKey = (db: Db, clientId: string, key: string) => db.prepare("SELECT value FROM source_state WHERE client_id = ? AND source = 'delivery' AND key = ?").pluck().get(clientId, key) as string | undefined;

// A once-generated, 128-bit random value (source_state: source='delivery'); not created in dry-run.
// The preview:<month> key is the random part of the month's preview path (the phase 9 Telegram message reads it from here).
function secret(db: Db, clientId: string, key: string, create: boolean): string {
  const have = stateKey(db, clientId, key);
  if (have || !create) return have ?? `<${key}>`;
  const v = randomBytes(16).toString("base64url");
  db.prepare("INSERT INTO source_state (client_id, source, key, value) VALUES (?, 'delivery', ?, ?)").run(clientId, key, v);
  return v;
}

const previewPath = (random: string) => `/preview/${random}/index.html`;

// The month's preview link (the phase 9 Telegram message); undefined if no preview has been made yet.
export function previewUrl(db: Db, baseUrl: string, clientId: string, month: string): string | undefined {
  const v = stateKey(db, clientId, `preview:${month}`);
  return v && join_(baseUrl, previewPath(v));
}

const join_ = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

function files(d: Deps, clientId: string, month: string) {
  const dir = join(d.outDir, clientId, month);
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      throw new Error(`${clientId} ${month}: hiányzik a ${join(dir, f)}; futtasd újra a reportot`);
    }
  };
  return { read, email: () => JSON.parse(read("email.json")) as EmailContent };
}

const row = (db: Db, clientId: string, month: string) =>
  db.prepare("SELECT status FROM reports WHERE client_id = ? AND month = ?").get(clientId, month) as { status: string } | undefined;

export function approve(db: Db, clientId: string, month: string, dryRun = false): void {
  const r = row(db, clientId, month);
  if (!r) throw new Error(`${clientId} ${month}: nincs riport; előbb: report ${month} --client ${clientId}`);
  if (r.status !== "draft") throw new Error(`${clientId} ${month}: csak draft riport hagyható jóvá (jelenlegi státusz: ${r.status})`);
  if (!dryRun) db.prepare("UPDATE reports SET status = 'approved', approved_at = ? WHERE client_id = ? AND month = ? AND status = 'draft'").run(new Date().toISOString(), clientId, month);
}

// Preview: the full report to the /preview/<random>/ path, the email to EMAIL_PREVIEW_TO. Draft only.
// The path is constant per month, so the same link stays live on regeneration.
export async function sendPreview(d: Deps, client: Client, month: string, to: string): Promise<string> {
  const r = row(d.db, client.id, month);
  if (r?.status !== "draft") throw new Error(`${client.id} ${month}: előnézet csak draft riporthoz van (státusz: ${r?.status ?? "nincs riport"})`);
  const f = files(d, client.id, month);
  const path = previewPath(secret(d.db, client.id, `preview:${month}`, !d.dryRun));
  const url = join_(d.baseUrl, path);
  const mail = withUrl(f.email(), url, "[Előnézet] ");
  if (d.dryRun) {
    d.say?.(`dry-run: feltöltés: ${path}\ndry-run: előnézet-email ide: ${to}, tárgy: ${mail.subject}, link: ${url}`);
    return url;
  }
  await d.store.put(path, f.read("preview.html"), "no-store");
  await d.mailer.send({ from: d.from, to: [to], ...mail });
  return url;
}

// Send: approved only. Upload (idempotent) → email to all recipients in one letter (recipients see each other:
// colleagues of the same client; one call, so no partial delivery) → sent only after success.
// If the email fails, the status stays approved, rerunning is safe. In sent state it does not send again.
// ponytail: two parallel sends for the same report can send a double email; it does not run on schedule, add a lock if it ever does.
export async function send(d: Deps, client: Client, month: string): Promise<"sent" | "already-sent"> {
  const r = row(d.db, client.id, month);
  if (r?.status === "sent") return "already-sent";
  if (r?.status !== "approved") throw new Error(`${client.id} ${month}: csak jóváhagyott riport küldhető (státusz: ${r?.status ?? "nincs riport"}); előbb: approve`);
  if (!client.recipients.length) throw new Error(`${client.id}: nincs címzett a config/clients/${client.id}.yaml-ban (recipients)`);
  const f = files(d, client.id, month);
  const path = `/r/${secret(d.db, client.id, "token", !d.dryRun)}/${month}/index.html`;
  const url = join_(d.baseUrl, path);
  const mail = withUrl(f.email(), url);
  const to = client.recipients.map((c) => c.email);
  if (d.dryRun) {
    d.say?.(`dry-run: feltöltés: ${path}\ndry-run: email ide: ${to.join(", ")}, tárgy: ${mail.subject}, link: ${url}`);
    return "sent";
  }
  await d.store.put(path, f.read("index.html"), CACHE);
  await d.mailer.send({ from: d.from, to, ...mail });
  d.db.prepare("UPDATE reports SET status = 'sent', sent_at = ?, url = ? WHERE client_id = ? AND month = ? AND status = 'approved'").run(new Date().toISOString(), url, client.id, month);
  return "sent";
}
