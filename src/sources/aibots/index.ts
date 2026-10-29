import { today } from "../../core/dates.ts";
import type { Db } from "../../core/db.ts";
import type { Client, Section, Source } from "../types.ts";

// AI crawler access: does robots.txt allow the AI search/answer and training bots, and does the server answer a request
// sent with their user agent. Tokens per the vendors' docs (OpenAI: developers.openai.com/api/docs/bots, Perplexity:
// docs.perplexity.ai/guides/bots, Anthropic: support.claude.com/en/articles/8896518, Google: google-common-crawlers).
// The HTTP test only catches user-agent based blocks (server rules, security plugins); a block on verified bot IPs
// (e.g. Cloudflare's AI bot blocking) is not reproducible from here. A snapshot of today: a past --day is skipped.
const SOURCE = "aibots";
const TIMEOUT_MS = 10_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
// The vendors' format ("compatible; <token>/<version>"); server rules match the token, the version does not matter.
const botUa = (token: string) => `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${token}/1.0)`;

// http: false for robots-only tokens (Google-Extended) and for Googlebot/Bingbot, whose spoofed UA WAF "fake bot" rules often block (false alarm).
export const BOTS = [
  { token: "OAI-SearchBot", name: "ChatGPT keresés", kind: "search", http: true },
  { token: "ChatGPT-User", name: "ChatGPT, felhasználói kérésre", kind: "search", http: true },
  { token: "PerplexityBot", name: "Perplexity keresés", kind: "search", http: true },
  { token: "Perplexity-User", name: "Perplexity, felhasználói kérésre", kind: "search", http: true },
  { token: "Claude-SearchBot", name: "Claude keresés", kind: "search", http: true },
  { token: "Claude-User", name: "Claude, felhasználói kérésre", kind: "search", http: true },
  { token: "Googlebot", name: "Google Keresés és AI-áttekintések", kind: "search", http: false },
  { token: "Google-Extended", name: "Gemini válaszai és tanítása", kind: "search", http: false },
  { token: "Bingbot", name: "Bing és Copilot", kind: "search", http: false },
  { token: "GPTBot", name: "OpenAI modelltanítás", kind: "training", http: true },
  { token: "ClaudeBot", name: "Anthropic modelltanítás", kind: "training", http: true },
  { token: "CCBot", name: "Common Crawl (sok modell tanítóadata)", kind: "training", http: true },
] as const;

type Rule = { allow: boolean; path: string };

const ruleMatches = (pattern: string, path: string) => {
  const end = pattern.endsWith("$");
  const body = (end ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${end ? "$" : ""}`).test(path);
};

// RFC 9309: the groups naming the product token (case-insensitive) merged, otherwise the "*" groups; the longest matching
// rule wins, allow on a tie; no matching rule = allowed. A group ends at the first user-agent line after a rule.
export function robotsAllows(txt: string, token: string, path: string): boolean {
  const groups: { agents: string[]; rules: Rule[]; closed: boolean }[] = [];
  let cur: (typeof groups)[number] | undefined;
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.replace(/#.*/, ""));
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!cur || cur.closed) groups.push((cur = { agents: [], rules: [], closed: false }));
      cur.agents.push(m[2].toLowerCase());
    } else if (cur && key !== "sitemap") {
      cur.closed = true;
      // An empty Disallow allows everything: it is no rule.
      if ((key === "allow" || key === "disallow") && m[2]) cur.rules.push({ allow: key === "allow", path: m[2] });
    }
  }
  const t = token.toLowerCase();
  let matched = groups.filter((g) => g.agents.includes(t));
  if (!matched.length) matched = groups.filter((g) => g.agents.includes("*"));
  let best: Rule | undefined;
  for (const r of matched.flatMap((g) => g.rules)) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best?.allow ?? true;
}

async function get(f: typeof fetch, url: string, ua: string): Promise<Response | null> {
  try {
    return await f(url, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

// 4xx: there is no robots.txt, no restriction (RFC 9309). 5xx or network error: the run fails instead of a false "everything blocked" state.
async function fetchRobots(f: typeof fetch, origin: string): Promise<string> {
  const res = await get(f, `${origin}/robots.txt`, BROWSER_UA);
  if (!res || res.status >= 500) throw new Error(`a robots.txt nem érhető el (${res ? `HTTP ${res.status}` : "hálózati hiba"})`);
  if (!res.ok) {
    await res.body?.cancel();
    return "";
  }
  return res.text();
}

const urlOf = (c: Client) => c.sources.aibots!.url ?? `https://${c.domain}/`;

// The stored state of a day: "metric|dimension" → value. robots_allowed and http_ok per bot token, llms_txt with dimension ''.
function stateOf(db: Db, clientId: string, day: string): Map<string, number> {
  const rows = db.prepare("SELECT metric, dimension, value FROM metrics WHERE client_id = ? AND source = 'aibots' AND period = 'day' AND date = ?").all(clientId, day) as { metric: string; dimension: string; value: number }[];
  return new Map(rows.map((r) => [`${r.metric}|${r.dimension}`, r.value]));
}
const allowed = (s: Map<string, number>, token: string) => s.get(`robots_allowed|${token}`) === 1 && s.get(`http_ok|${token}`) !== 0;

export interface Deps {
  fetch?: typeof fetch;
  now?: () => Date;
}

export function makeSource(deps: Deps = {}): Source {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  return {
    id: SOURCE,
    defaultDay: () => today(now()),

    // A change against the last earlier measured day becomes an event (access_blocked / access_restored); the first measurement has nothing to compare to.
    async collect(ctx, client, day) {
      if (day !== today(now())) return console.log(`${client.id} aibots: csak a mai állapotot méri, ${day} kimarad`);
      const { db } = ctx;
      const url = new URL(urlOf(client));
      const robots = await fetchRobots(f, url.origin);
      // Only a bot-specific refusal counts: if a plain browser request fails too, that is an outage (uptime), not blocking.
      const base = await get(f, url.href, BROWSER_UA);
      await base?.body?.cancel();
      const baseOk = !!base && base.status < 400;
      const state = new Map<string, number>();
      for (const b of BOTS) {
        state.set(`robots_allowed|${b.token}`, robotsAllows(robots, b.token, url.pathname) ? 1 : 0);
        if (!b.http || !baseOk) continue;
        // Sequential, not parallel: a burst could be rate limited (429), which would look like blocking.
        const res = await get(f, url.href, botUa(b.token));
        await res?.body?.cancel();
        state.set(`http_ok|${b.token}`, res && res.status < 400 ? 1 : 0);
      }
      const llms = await get(f, `${url.origin}/llms.txt`, BROWSER_UA);
      // Soft 404 (an HTML page with 200 for any path) does not count as llms.txt.
      state.set("llms_txt|", llms?.ok && !llms.headers.get("content-type")?.includes("html") ? 1 : 0);
      await llms?.body?.cancel();

      const prevDay = db.prepare("SELECT max(date) FROM metrics WHERE client_id = ? AND source = 'aibots' AND period = 'day' AND date < ?").pluck().get(client.id, day) as string | null;
      const prev = prevDay ? stateOf(db, client.id, prevDay) : null;
      const ts = now().toISOString();
      const ins = db.prepare("INSERT INTO metrics (client_id, source, metric, dimension, period, date, value) VALUES (?, 'aibots', ?, ?, 'day', ?, ?)");
      const event = db.prepare("INSERT OR IGNORE INTO events (client_id, source, external_id, type, ts, title, meta_json) VALUES (?, 'aibots', ?, ?, ?, ?, ?)");
      db.transaction(() => {
        // Delete first: an http_ok row of an earlier run today may not apply now.
        db.prepare("DELETE FROM metrics WHERE client_id = ? AND source = 'aibots' AND date = ?").run(client.id, day);
        for (const [k, v] of state) ins.run(client.id, ...k.split("|"), day, v);
        for (const b of BOTS) {
          if (!prev?.has(`robots_allowed|${b.token}`)) continue;
          const ok = allowed(state, b.token);
          if (ok === allowed(prev, b.token)) continue;
          const robotsOk = state.get(`robots_allowed|${b.token}`) === 1;
          const why = ok ? "" : robotsOk ? ": a szerver elutasítja" : ": a robots.txt tiltja";
          const type = ok ? "access_restored" : "access_blocked";
          event.run(client.id, `${type}:${b.token}:${day}`, type, ts, `${b.token} (${b.name}) ${ok ? "újra eléri az oldalt" : `nem éri el az oldalt${why}`}`,
            JSON.stringify({ day, token: b.token, allowed: ok, robots: robotsOk, http: state.get(`http_ok|${b.token}`) ?? null }));
        }
      })();
    },

    // The state of the last measured day of the month and the month's changes.
    async summarize(ctx, client, month) {
      const { db } = ctx;
      const day = db.prepare("SELECT max(date) FROM metrics WHERE client_id = ? AND source = 'aibots' AND period = 'day' AND date LIKE ?").pluck().get(client.id, `${month}-%`) as string | null;
      if (!day) return null;
      const s = stateOf(db, client.id, day);
      const bots = BOTS.filter((b) => s.has(`robots_allowed|${b.token}`)).map((b) => ({
        token: b.token,
        name: b.name,
        kind: b.kind,
        robots: s.get(`robots_allowed|${b.token}`) === 1,
        http: s.has(`http_ok|${b.token}`) ? s.get(`http_ok|${b.token}`) === 1 : null,
      }));
      const changes = (db
        .prepare("SELECT title, meta_json FROM events WHERE client_id = ? AND source = 'aibots' AND json_extract(meta_json, '$.day') LIKE ? ORDER BY ts, id")
        .all(client.id, `${month}-%`) as { title: string; meta_json: string }[])
        .map((e) => ({ ...(JSON.parse(e.meta_json) as { day: string; token: string; allowed: boolean }), title: e.title }));
      const data: Section["data"] = { month, checkedOn: day, url: urlOf(client), llmsTxt: s.get("llms_txt|") === 1, bots, changes };
      return { source: SOURCE, data };
    },
  };
}

export const aibots = makeSource();
