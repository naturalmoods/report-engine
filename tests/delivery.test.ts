import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../scripts/build-email.ts";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { postalMailer, type Mail, type Mailer } from "../src/delivery/email.ts";
import { approve, send, sendPreview, type Deps } from "../src/delivery/flow.ts";
import { r2Storage, type Storage } from "../src/delivery/r2.ts";
import { buildEmail } from "../src/report/email.ts";
import { num } from "../src/report/html.ts";
import { generateReport } from "../src/report/index.ts";

const [base] = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients;
const client = { ...base, recipients: [{ name: "A", email: "a@teszt.hu" }, { name: "B", email: "b@teszt.hu" }] };
const NOW = new Date("2026-10-04T05:00:00Z");
const M = "2026-09";
const EVIL = `<script>alert("x")</script>`;

test("email-sablon: az MJML-fordítás figyelmeztetés nélkül fut, és a commitolt HTML szinkronban van a forrással", async () => {
  const html = await compile(); // strict validation, throws on error
  assert.equal(readFileSync(new URL("../src/report/templates/email/email.html", import.meta.url), "utf8"), html, "futtasd: npm run build:email");
});

test("email: kulcsszámok, escape, hu-HU formátum, URL-hely HTML-ben és szövegben, külső erőforrás nélkül", () => {
  const sections: [string, any][] = [
    ["gsc", { data: { totals: { clicks: 12345, impressions: 99000 }, vsPreviousMonth: { clicks: 0.123, impressions: -0.05 } } }],
    ["uptime", { data: { availabilityPct: 99.996, downtimes: [{}], downtimeSeconds: 600 } }],
    ["worklog", { data: { events: { manual: [{ title: EVIL }], commit: [{ title: "titkos commit" }] } } }],
  ];
  const e = buildEmail({ ...client, name: `Teszt & "Kft"` }, M, sections, { workItems: [EVIL, "Biztonsági frissítés"], summary: `Összefoglaló <b>${EVIL}`, suggestions: [] });
  assert.equal(e.subject, `Teszt & "Kft": havi riport, 2026. szeptember`);
  assert.ok(!e.html.includes("<script") && !e.html.includes("<b>"));
  assert.ok(e.html.includes("&lt;script&gt;") && e.html.includes("Teszt &amp; &quot;Kft&quot;"));
  assert.ok(e.html.includes(num(12345)) && e.html.includes("+12,3% az előző hónaphoz képest") && e.html.includes("99,99%"));
  assert.ok(e.html.includes('href="{{URL}}"') && e.text.includes("Teljes riport: {{URL}}"));
  assert.ok(!/<svg|<img|@import|https?:\/\/fonts/i.test(e.html));
  assert.match(e.html, /prefers-color-scheme:\s*dark/);
  assert.ok(e.text.includes(`Kattintás a keresőből: ${num(12345)}`));
  // Without AI the manual entries, not the commit titles.
  const plain = buildEmail(client, M, sections);
  assert.ok(plain.html.includes("&lt;script&gt;") && !plain.html.includes("titkos commit") && !plain.html.includes("AI segítségével"));
  assert.ok(plain.html.includes(">Havi riport</div>"));
  const branded = buildEmail(client, M, sections, undefined, "Példa & Társa");
  assert.ok(branded.html.includes("Példa &amp; Társa · havi riport") && branded.text.includes("\nPélda & Társa\n"));
});

// --- State machine and send flow with fake adapters ---
function setup() {
  const db = openDb(":memory:");
  const outDir = mkdtempSync(join(tmpdir(), "delivery-"));
  const puts: { key: string; html: string; cc: string }[] = [];
  const mails: Mail[] = [];
  const f = { failMail: false };
  const store: Storage = { put: async (key, html, cc) => void puts.push({ key, html, cc }) };
  const mailer: Mailer = {
    send: async (m) => {
      if (f.failMail) throw new Error("Postal: leállt");
      mails.push(m);
    },
  };
  const said: string[] = [];
  const deps: Deps = { db, outDir, store, mailer, from: "riport@example.hu", baseUrl: "https://r.example.hu/", say: (l) => said.push(l) };
  const report = () => generateReport({ db, env: {} }, client, M, { outDir, now: NOW });
  const status = () => db.prepare("SELECT status, sent_at, approved_at, url FROM reports").get() as any;
  return { db, deps, puts, mails, f, said, report, status };
}

test("állapotgép: megengedett átmenetek draft → approved → sent, tiltottak hibával", async () => {
  const s = setup();
  await assert.rejects(send(s.deps, client, M), /csak jóváhagyott/); // no report
  assert.throws(() => approve(s.db, client.id, M), /nincs riport/);
  await s.report();
  await assert.rejects(send(s.deps, client, M), /csak jóváhagyott.*draft/); // a draft cannot be sent
  approve(s.db, client.id, M);
  assert.equal(s.status().status, "approved");
  assert.ok(s.status().approved_at);
  assert.throws(() => approve(s.db, client.id, M), /csak draft.*approved/); // double approval
  await assert.rejects(s.report(), /nem írható felül/); // no regeneration after approval
  assert.equal(await send(s.deps, client, M), "sent");
  assert.throws(() => approve(s.db, client.id, M), /csak draft.*sent/);
  await assert.rejects(s.report(), /nem írható felül/);
});

test("send: feltöltés tokenes útvonalra, egy email az összes címzettnek, sent időbélyeggel; másodszor nem küld", async () => {
  const s = setup();
  await s.report();
  approve(s.db, client.id, M);
  await send(s.deps, client, M);
  const token = s.db.prepare("SELECT value FROM source_state WHERE client_id = ? AND source = 'delivery' AND key = 'token'").pluck().get(client.id) as string;
  assert.match(token, /^[A-Za-z0-9_-]{22}$/); // 128 bits, base64url
  assert.equal(s.puts.length, 1);
  assert.equal(s.puts[0].key, `/r/${token}/${M}/index.html`);
  assert.equal(s.puts[0].html, readFileSync(join(s.deps.outDir, client.id, M, "index.html"), "utf8"));
  assert.match(s.puts[0].cc, /max-age/);
  const url = `https://r.example.hu/r/${token}/${M}/index.html`;
  assert.equal(s.mails.length, 1);
  assert.deepEqual(s.mails[0].to, ["a@teszt.hu", "b@teszt.hu"]);
  assert.equal(s.mails[0].from, "riport@example.hu");
  assert.ok(s.mails[0].html.includes(`href="${url}"`) && s.mails[0].text.includes(url) && !s.mails[0].subject.includes("Előnézet"));
  assert.equal(s.status().status, "sent");
  assert.equal(s.status().url, url);
  assert.ok(s.status().sent_at);
  assert.equal(await send(s.deps, client, M), "already-sent");
  assert.equal(s.mails.length, 1);
  assert.equal(s.puts.length, 1);
});

test("send: email-hiba után approved marad, az újrafuttatás kiküld; a token ügyfelenként állandó", async () => {
  const s = setup();
  await s.report();
  approve(s.db, client.id, M);
  s.f.failMail = true;
  await assert.rejects(send(s.deps, client, M), /Postal/);
  assert.equal(s.status().status, "approved");
  assert.equal(s.status().sent_at, null);
  s.f.failMail = false;
  await send(s.deps, client, M);
  assert.equal(s.status().status, "sent");
  assert.equal(s.mails.length, 1);
  assert.equal(s.puts[0].key, s.puts[1].key); // same path: the upload is idempotent
});

test("send: címzett nélkül hiba, és semmi nem megy ki", async () => {
  const s = setup();
  await s.report();
  approve(s.db, client.id, M);
  await assert.rejects(send(s.deps, { ...client, recipients: [] }, M), /nincs címzett/);
  assert.equal(s.puts.length + s.mails.length, 0);
});

test("--dry-run: kiírja, mit tenne; nincs feltöltés, email, státuszváltás, token", async () => {
  const s = setup();
  await s.report();
  approve(s.db, client.id, M);
  await send({ ...s.deps, dryRun: true }, client, M);
  assert.equal(s.puts.length + s.mails.length, 0);
  assert.equal(s.status().status, "approved");
  assert.equal(s.db.prepare("SELECT count(*) FROM source_state").pluck().get(), 0);
  assert.match(s.said.join("\n"), /a@teszt\.hu, b@teszt\.hu/);
  await sendPreview({ ...s.deps, dryRun: true }, { ...client }, M, "p@x.hu").catch(() => {}); // approved: not a draft
});

test("előnézet: csak draftra; /preview/<véletlen>/ útvonal, email az EMAIL_PREVIEW_TO-ra; újragenerálás után ugyanaz a link", async () => {
  const s = setup();
  await s.report();
  const url = await sendPreview(s.deps, client, M, "belso@example.hu");
  assert.match(url, /^https:\/\/r\.example\.hu\/preview\/[A-Za-z0-9_-]{22}\/index\.html$/);
  assert.equal(s.puts[0].key, new URL(url).pathname);
  assert.equal(s.puts[0].html, readFileSync(join(s.deps.outDir, client.id, M, "preview.html"), "utf8"));
  assert.deepEqual(s.mails[0].to, ["belso@example.hu"]);
  assert.ok(s.mails[0].subject.startsWith("[Előnézet] ") && s.mails[0].html.includes(url));
  await s.report();
  assert.equal(await sendPreview(s.deps, client, M, "belso@example.hu"), url);
  const dry = setup();
  await dry.report();
  await sendPreview({ ...dry.deps, dryRun: true }, client, M, "belso@example.hu");
  assert.equal(dry.puts.length + dry.mails.length, 0);
  assert.equal(dry.db.prepare("SELECT count(*) FROM source_state").pluck().get(), 0);
  approve(s.db, client.id, M);
  await assert.rejects(sendPreview(s.deps, client, M, "x@y.hu"), /csak draft/);
});

test("Postal-adapter: kérés alakja, X-Server-API-Key, hibák kulcs nélkül", async () => {
  const calls: { url: string; init: any }[] = [];
  const reply = (status: number, body: unknown): typeof fetch => (async (url: any, init: any) => (calls.push({ url: String(url), init }), new Response(JSON.stringify(body), { status }))) as any;
  const mail: Mail = { from: "a@b.hu", to: ["c@d.hu", "e@f.hu"], subject: "T", html: "<p>h</p>", text: "t" };
  const env = { POSTAL_URL: "https://postal.example.hu", POSTAL_API_KEY: "TITOKKULCS" };
  await postalMailer(env, reply(200, { status: "success", time: 0.1, flags: {}, data: { message_id: "x", messages: {} } })).send(mail);
  assert.equal(calls[0].url, "https://postal.example.hu/api/v1/send/message");
  assert.equal(calls[0].init.headers["X-Server-API-Key"], "TITOKKULCS");
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: "a@b.hu", to: ["c@d.hu", "e@f.hu"], subject: "T", html_body: "<p>h</p>", plain_body: "t" });
  // Postal can return an error with 200 too.
  await assert.rejects(postalMailer(env, reply(200, { status: "error", data: { code: "NoRecipients", message: "nincs címzett" } })).send(mail), /Postal.*nincs címzett/);
  await assert.rejects(postalMailer(env, reply(500, "nem json")).send(mail), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes("TITOKKULCS"));
});

test("r2Storage: az S3 Key nem kezdődik /-jellel", async () => {
  const sent: any[] = [];
  const store = r2Storage({ R2_BUCKET_REPORTS: "b" }, { send: async (c: any) => void sent.push(c.input) } as any);
  await store.put("/r/tok/2026-09/index.html", "<p>", "no-store");
  await store.put("//preview/x/index.html", "<p>", "no-store");
  assert.deepEqual(sent.map((i) => i.Key), ["r/tok/2026-09/index.html", "preview/x/index.html"]);
});
