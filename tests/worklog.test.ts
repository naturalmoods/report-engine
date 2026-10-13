import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadClients } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { addManual, classify, makeSource } from "../src/sources/worklog/index.ts";

const [client] = loadClients(join(import.meta.dirname, "fixtures/clients/ok")).clients;
const REPO = client.sources.worklog!.repos[0];
const API = `https://api.github.com/repos/${REPO}/commits`;

const commit = (sha: string, date: string, o: { parents?: number; login?: string; name?: string; committed?: string } = {}) => ({
  sha,
  html_url: `https://github.com/${REPO}/commit/${sha}`,
  parents: Array.from({ length: o.parents ?? 1 }, () => ({})),
  author: { login: o.login ?? "peter" },
  committer: { login: o.login ?? "peter" },
  commit: { message: `${sha} üzenet\n\nrészletek`, author: { name: o.name ?? "Péter", date }, committer: { name: "x", date: o.committed ?? date } },
});

// Fake GitHub: pages in order; records the called URLs. The pages paginate via the Link: rel="next" header.
function fakeGh(pages: unknown[][], status = 200, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (status !== 200) return new Response("{}", { status, headers });
    const i = Number(new URL(url).searchParams.get("page") ?? 1) - 1;
    const h: Record<string, string> = i + 1 < pages.length ? { link: `<${API}?page=${i + 2}>; rel="next"` } : {};
    return new Response(JSON.stringify(pages[i]), { status: 200, headers: h });
  }) as typeof fetch;
  return { src: makeSource({ fetch: f, token: () => "titkos-token-123" }), urls };
}
const ctxOf = () => ({ db: openDb(":memory:"), env: {} });
const evs = (db: any) => db.prepare("SELECT type, ts, title FROM events ORDER BY ts").all();
const cursor = (db: any) => db.prepare("SELECT value FROM source_state WHERE key = ?").pluck().get(`cursor:${REPO}`);

test("worklog: lapozás, szerzői dátum ts, típusbesorolás", async () => {
  const { src, urls } = fakeGh([
    [commit("a1", "2026-09-03T10:00:00Z"), commit("a2", "2026-09-02T10:00:00Z", { parents: 2 })],
    [commit("a3", "2026-09-01T10:00:00Z", { login: "dependabot[bot]" })],
  ]);
  const ctx = ctxOf();
  await src.collect(ctx, client, "2026-09-10");
  assert.equal(urls.length, 2);
  assert.deepEqual(evs(ctx.db).map((e: any) => e.type), ["bot", "merge", "commit"]);
  assert.equal(evs(ctx.db)[2].title, "a1 üzenet");
});

test("worklog: osztályozás (botnév login nélkül, merge a botnál erősebb)", () => {
  assert.equal(classify(commit("x", "2026-01-01T00:00:00Z", { name: "renovate" }) as any), "bot");
  assert.equal(classify(commit("x", "2026-01-01T00:00:00Z", { login: "github-actions[bot]", parents: 2 }) as any), "merge");
});

test("worklog: kurzor továbblép, újrafutás nem duplikál, a következő kérés since=kurzor", async () => {
  const ctx = ctxOf();
  const first = fakeGh([[commit("a1", "2026-09-03T10:00:00Z", { committed: "2026-09-04T08:00:00Z" })]]);
  await first.src.collect(ctx, client, "2026-09-10");
  assert.equal(cursor(ctx.db), "2026-09-04T08:00:00Z");
  assert.match(first.urls[0], /since=\d{4}-\d{2}-01T00:00:00Z/); // first run: 16 months
  const second = fakeGh([[commit("a1", "2026-09-03T10:00:00Z", { committed: "2026-09-04T08:00:00Z" }), commit("a2", "2026-09-05T10:00:00Z")]]);
  await second.src.collect(ctx, client, "2026-09-11");
  assert.ok(second.urls[0].includes("since=2026-09-04T08:00:00Z"));
  assert.equal(evs(ctx.db).length, 2); // a1 is not duplicated
  assert.equal(cursor(ctx.db), "2026-09-05T10:00:00Z");
});

test("worklog: félbeszakadt lapozás nem lépteti a kurzort és nem ment semmit", async () => {
  const ctx = ctxOf();
  let n = 0;
  const f = (async () => {
    if (++n === 2) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify([commit("a1", "2026-09-03T10:00:00Z")]), { headers: { link: `<${API}?page=2>; rel="next"` } });
  }) as typeof fetch;
  await assert.rejects(makeSource({ fetch: f, token: () => "t" }).collect(ctx, client, "2026-09-10"));
  assert.equal(evs(ctx.db).length, 0);
  assert.equal(cursor(ctx.db), undefined);
});

test("worklog: 404/403 nevezi a repót és az okot, 401 és rate limit külön; a token nem szivárog", async () => {
  for (const [status, headers, re] of [
    [404, {}, /nem fér hozzá/],
    [403, {}, /nem fér hozzá/],
    [401, {}, /401/],
    [403, { "x-ratelimit-remaining": "0" }, /rate limit/],
  ] as const) {
    const { src } = fakeGh([[]], status, headers as any);
    await assert.rejects(src.collect(ctxOf(), client, "d"), (e: Error) => e.message.includes(REPO) && re.test(e.message) && !e.message.includes("titkos"));
  }
});

test("worklog: egy repó hibája nem állítja le a többit, de a futás hibás", async () => {
  const two = { ...client, sources: { ...client.sources, worklog: { enabled: true, repos: ["a/rossz", REPO] } } };
  const f = (async (url: string) =>
    url.includes("a/rossz") ? new Response("{}", { status: 404 }) : new Response(JSON.stringify([commit("a1", "2026-09-03T10:00:00Z")]))) as typeof fetch;
  const ctx = ctxOf();
  await assert.rejects(makeSource({ fetch: f, token: () => "t" }).collect(ctx, two, "d"), /a\/rossz/);
  assert.equal(evs(ctx.db).length, 1);
});

test("worklog: kézi bejegyzés + summarize (Budapest-hónap, típusonkénti darabszám, percek)", async () => {
  const ctx = ctxOf();
  const { src } = fakeGh([[commit("a1", "2026-08-31T22:30:00Z"), commit("a2", "2026-09-15T10:00:00Z")]]); // the first is Sept 1 in Budapest
  await src.collect(ctx, client, "d");
  addManual(ctx.db, client.id, "Telefon az ügyféllel", "2026-09-20", 30);
  addManual(ctx.db, client.id, "Telefon az ügyféllel", "2026-09-20", 15); // intentionally not deduplicated
  addManual(ctx.db, client.id, "Október", "2026-10-01");
  const s = (await src.summarize(ctx, client, "2026-09"))!;
  assert.deepEqual(s.data.counts, { commit: 2, manual: 2 });
  assert.equal(s.data.manualMinutes, 45);
  assert.equal(await src.summarize(ctx, client, "2026-07"), null);
});

test("worklog: hiányzó token csak ezt a forrást bukja, dry-run nem hív API-t", async () => {
  const src = makeSource({ fetch: (() => { throw new Error("nem hívható"); }) as any });
  await assert.rejects(src.collect(ctxOf(), client, "d"), /GITHUB_TOKEN/);
  await src.backfill!({ ...ctxOf(), dryRun: true }, client, "2026-01");
});
