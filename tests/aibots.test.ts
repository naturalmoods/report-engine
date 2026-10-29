import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { BOTS, makeSource, robotsAllows } from "../src/sources/aibots/index.ts";

const base = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients[0];
const client = { ...base, sources: { ...base.sources, aibots: { enabled: true } } };
const ctxOf = () => ({ db: openDb(":memory:"), env: {} });

test("robotsAllows: saját csoport a * helyett, leghosszabb szabály nyer, döntetlennél allow, wildcard és $", () => {
  const txt = `
User-agent: *
Disallow: /admin
Disallow: /*.pdf$

User-agent: GPTBot
User-agent: CCBot # comment
Disallow: /

User-agent: OAI-SearchBot
Disallow:

User-agent: ClaudeBot
Disallow: /
Allow: /blog
Sitemap: https://teszt.hu/sitemap.xml`;
  assert.equal(robotsAllows(txt, "GPTBot", "/"), false);
  assert.equal(robotsAllows(txt, "ccbot", "/"), false); // case-insensitive
  // An empty Disallow is no rule: the group is not merged with the next one, the bot is allowed.
  assert.equal(robotsAllows(txt, "OAI-SearchBot", "/"), true);
  assert.equal(robotsAllows(txt, "PerplexityBot", "/"), true); // falls back to *
  assert.equal(robotsAllows(txt, "PerplexityBot", "/admin/x"), false);
  assert.equal(robotsAllows(txt, "PerplexityBot", "/a/b.pdf"), false);
  assert.equal(robotsAllows(txt, "PerplexityBot", "/a/b.pdf?x"), true);
  assert.equal(robotsAllows(txt, "ClaudeBot", "/blog/post"), true);
  assert.equal(robotsAllows(txt, "ClaudeBot", "/"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\nAllow: /$", "X", "/"), true);
  assert.equal(robotsAllows("", "GPTBot", "/"), true);
});

// Fake site: robots.txt, llms.txt and a UA-based block (blocked tokens get 403).
function site(opts: { robots?: string | number; blocked?: string[]; down?: boolean; llms?: string }) {
  const calls: { url: string; ua: string }[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string>)["user-agent"];
    calls.push({ url: String(u), ua });
    if (String(u).endsWith("/robots.txt")) return typeof opts.robots === "number" ? new Response("", { status: opts.robots }) : new Response(opts.robots ?? "");
    if (String(u).endsWith("/llms.txt")) return opts.llms ? new Response("# x", { headers: { "content-type": opts.llms } }) : new Response("", { status: 404 });
    if (opts.down) return new Response("", { status: 502 });
    return new Response("ok", { status: opts.blocked?.some((t) => ua.includes(`${t}/`)) ? 403 : 200 });
  }) as typeof fetch;
  return { f, calls };
}
const at = (day: string) => () => new Date(`${day}T10:00:00Z`);

test("aibots collect: robots.txt és UA-blokk naponta, változásból esemény; újrafuttatva nem duplikál", async () => {
  const ctx = ctxOf();
  const first = site({ robots: "User-agent: GPTBot\nDisallow: /", llms: "text/plain" });
  await makeSource({ fetch: first.f, now: at("2026-09-10") }).collect(ctx, client, "2026-09-10");
  assert.equal(first.calls[0].url, "https://teszt.hu/robots.txt");
  // Robots-only and Googlebot/Bingbot are not requested with their UA.
  assert.ok(!first.calls.some((c) => /Googlebot|Bingbot|Google-Extended/.test(c.ua)));
  assert.equal(ctx.db.prepare("SELECT count(*) FROM events").pluck().get(), 0); // first measurement: nothing to compare

  const later = makeSource({ fetch: site({ robots: "", blocked: ["OAI-SearchBot"] }).f, now: at("2026-09-11") });
  await later.collect(ctx, client, "2026-09-11");
  await later.collect(ctx, client, "2026-09-11");
  const ev = ctx.db.prepare("SELECT type, title FROM events ORDER BY id").all() as { type: string; title: string }[];
  assert.deepEqual(ev.map((e) => e.type), ["access_blocked", "access_restored"]);
  assert.match(ev[0].title, /OAI-SearchBot .*szerver elutasítja/);
  assert.match(ev[1].title, /GPTBot .*újra eléri/);

  const s = (await later.summarize(ctx, client, "2026-09"))!.data as any;
  assert.equal(s.checkedOn, "2026-09-11");
  assert.equal(s.llmsTxt, false);
  assert.equal(s.bots.length, BOTS.length);
  assert.deepEqual(s.bots.find((b: any) => b.token === "OAI-SearchBot"), { token: "OAI-SearchBot", name: "ChatGPT keresés", kind: "search", robots: true, http: false });
  assert.equal(s.bots.find((b: any) => b.token === "Googlebot").http, null);
  assert.equal(s.changes.length, 2);
});

test("aibots collect: ha böngészővel sem érhető el, a UA-teszt kimarad (nem tiltás); 5xx robots.txt hibát dob; múltbeli nap kimarad", async () => {
  const ctx = ctxOf();
  await makeSource({ fetch: site({ down: true }).f, now: at("2026-09-10") }).collect(ctx, client, "2026-09-10");
  assert.equal(ctx.db.prepare("SELECT count(*) FROM metrics WHERE metric = 'http_ok'").pluck().get(), 0);
  await assert.rejects(makeSource({ fetch: site({ robots: 503 }).f, now: at("2026-09-11") }).collect(ctx, client, "2026-09-11"), /robots\.txt nem érhető el \(HTTP 503\)/);
  // 404 robots.txt = no restriction.
  await makeSource({ fetch: site({ robots: 404 }).f, now: at("2026-09-12") }).collect(ctx, client, "2026-09-12");
  assert.equal(ctx.db.prepare("SELECT min(value) FROM metrics WHERE metric = 'robots_allowed' AND date = '2026-09-12'").pluck().get(), 1);
  const { f, calls } = site({});
  const log = console.log;
  console.log = () => {};
  try {
    await makeSource({ fetch: f, now: at("2026-09-13") }).collect(ctx, client, "2026-09-01");
  } finally {
    console.log = log;
  }
  assert.equal(calls.length, 0);
});

test("aibots riport és AI-bemenet: tiltott keresők külön a tanítóktól, escape-elt cím", async () => {
  const { renderReport } = await import("../src/report/index.ts");
  const { aiInput } = await import("../src/report/ai.ts");
  const ctx = ctxOf();
  const src = makeSource({ fetch: site({ robots: "User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /" }).f, now: at("2026-09-10") });
  await src.collect(ctx, client, "2026-09-10");
  const sections: [string, any][] = [["aibots", await src.summarize(ctx, client, "2026-09")]];
  const page = renderReport(client, "2026-09", sections, { now: new Date("2026-10-04T07:00:00Z") });
  assert.match(page, /AI-keresők hozzáférése/);
  assert.match(page, /<span class="bad">tiltja<\/span>/);
  assert.match(page, /8 \/ 9/);
  const a = aiInput(client, "2026-09", sections).aiAccess;
  assert.deepEqual(a.blockedSearchBots, ["Perplexity keresés (PerplexityBot)"]);
  assert.deepEqual(a.blockedTrainingBots, ["OpenAI modelltanítás (GPTBot)"]);
});
