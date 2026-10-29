import { addDays, addMonths, lastDayOf, today } from "../../core/dates.ts";
import type { Db } from "../../core/db.ts";
import { sourceEnv } from "../../core/env.ts";
import type { Client, Ctx, Section, Source } from "../types.ts";

// Cloudflare Web Analytics (JS beacon, works on gray-clouded sites too) via the GraphQL Analytics API,
// dataset rumPageloadEventsAdaptiveGroups, bots excluded. Days are UTC dates as Cloudflare gives them.
// count = page views, sum.visits = visits; both come already scaled by the sample interval (estimates:
// on low traffic they move in steps of 10). Unsampled data is kept for only 7 days, hence the 7-day rolling window.
const SOURCE = "cloudflare";
const TOP = 50;
const WINDOW = 7;
const URL = "https://api.cloudflare.com/client/v4/graphql";
const defaultDay = () => addDays(today(), -1);
const site = (c: Client) => c.sources.cloudflare!.siteTag;

export type Dimension = "date" | "requestPath" | "refererHost";
export type Group = { count: number; sum: { visits: number }; dimensions: Partial<Record<Dimension, string>> };
export type Query = (siteTag: string, from: string, to: string, dimension: Dimension, limit: number) => Promise<Group[]>;

const ORDER: Record<Dimension, string> = { date: "date_ASC", requestPath: "count_DESC", refererHost: "sum_visits_DESC" };
// The dimension comes from the fixed Dimension union, never from input.
const gql = (dim: Dimension) => `query($account: string!, $site: string!, $from: Date!, $to: Date!, $limit: uint64!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: rumPageloadEventsAdaptiveGroups(limit: $limit, orderBy: [${ORDER[dim]}],
      filter: { siteTag: $site, date_geq: $from, date_leq: $to, bot: 0 }) { count sum { visits } dimensions { ${dim} } }
  } }
}`;

export function createQuery(token: string, account: string, f: typeof fetch = fetch): Query {
  return async (siteTag, from, to, dimension, limit) => {
    const res = await f(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: gql(dimension), variables: { account, site: siteTag, from, to, limit } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403)
      throw new Error(`a Cloudflare elutasította a tokent (${res.status}): Account Analytics Read jog kell a fiókra`);
    if (!res.ok) throw new Error(`Cloudflare GraphQL hiba: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { viewer?: { accounts?: { rows: Group[] }[] } }; errors?: { message: string }[] | null };
    if (body.errors?.length) throw new Error(`Cloudflare GraphQL hiba: ${body.errors.map((e) => e.message).join("; ")}`);
    const acc = body.data?.viewer?.accounts?.[0];
    if (!acc) throw new Error("a Cloudflare-fiók nem érhető el a tokennel (CLOUDFLARE_ACCOUNT_ID)");
    return acc.rows;
  };
}

const UPSERT = `INSERT INTO metrics (client_id, source, metric, dimension, period, date, value)
  VALUES (?, 'cloudflare', ?, ?, ?, ?, ?)
  ON CONFLICT (client_id, source, metric, dimension, period, date) DO UPDATE SET value = excluded.value`;

function saveDays(db: Db, clientId: string, rows: Group[]): void {
  const up = db.prepare(UPSERT);
  db.transaction(() => {
    for (const r of rows) {
      up.run(clientId, "visits", "", "day", r.dimensions.date, r.sum.visits);
      up.run(clientId, "pageviews", "", "day", r.dimensions.date, r.count);
    }
  })();
}

// Delete first, then insert, in one transaction: a rerun leaves no stale row.
function saveMonth(db: Db, clientId: string, month: string, paths: Group[], referers: Group[]): void {
  const up = db.prepare(UPSERT);
  db.transaction(() => {
    db.prepare("DELETE FROM metrics WHERE client_id = ? AND source = 'cloudflare' AND period = 'month' AND date = ?").run(clientId, month);
    for (const r of paths) {
      up.run(clientId, "pageviews", `path:${r.dimensions.requestPath}`, "month", month, r.count);
      up.run(clientId, "visits", `path:${r.dimensions.requestPath}`, "month", month, r.sum.visits);
    }
    // Internal navigation has the site's own host as referer and 0 visits; it is not a traffic source.
    for (const r of referers) if (r.sum.visits > 0) up.run(clientId, "visits", `referer:${r.dimensions.refererHost ?? ""}`, "month", month, r.sum.visits);
  })();
}

type Totals = { visits: number; pageviews: number };

function monthTotals(db: Db, clientId: string, month: string): Totals | null {
  const r = db
    .prepare(
      `SELECT count(*) AS n, sum(CASE metric WHEN 'visits' THEN value END) AS visits, sum(CASE metric WHEN 'pageviews' THEN value END) AS pageviews
       FROM metrics WHERE client_id = ? AND source = 'cloudflare' AND period = 'day' AND date LIKE ?`,
    )
    .get(clientId, `${month}-%`) as { n: number; visits: number; pageviews: number };
  return r.n ? { visits: r.visits ?? 0, pageviews: r.pageviews ?? 0 } : null;
}

function topList(db: Db, clientId: string, month: string, prefix: "path" | "referer") {
  const rows = db
    .prepare(
      `SELECT dimension, metric, value FROM metrics WHERE client_id = ? AND source = 'cloudflare' AND period = 'month'
       AND date = ? AND dimension LIKE ?`,
    )
    .all(clientId, month, `${prefix}:%`) as { dimension: string; metric: string; value: number }[];
  const by = new Map<string, { key: string; visits: number; pageviews: number }>();
  for (const r of rows) {
    const key = r.dimension.slice(prefix.length + 1);
    by.set(key, { ...(by.get(key) ?? { key, visits: 0, pageviews: 0 }), [r.metric]: r.value });
  }
  const sortBy = prefix === "path" ? "pageviews" : "visits";
  return [...by.values()].sort((a, b) => b[sortBy] - a[sortBy]);
}

const pct = (cur: number, prev: number) => (prev ? (cur - prev) / prev : null);

// Referrer hosts of AI assistants (the host itself or a subdomain of it). A lower bound: many AI apps send no referrer
// (those land in direct traffic), and only the monthly top referrers are stored.
const AI_REFERRERS: Record<string, string> = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "perplexity.ai": "Perplexity",
  "gemini.google.com": "Gemini",
  "copilot.microsoft.com": "Copilot",
  "claude.ai": "Claude",
  "chat.deepseek.com": "DeepSeek",
  "grok.com": "Grok",
  "chat.mistral.ai": "Le Chat",
};
export const aiAssistant = (host: string) => Object.entries(AI_REFERRERS).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1];

function aiReferrals(referrers: { key: string; visits: number }[]) {
  const by = new Map<string, number>();
  for (const r of referrers) {
    const name = aiAssistant(r.key);
    if (name) by.set(name, (by.get(name) ?? 0) + r.visits);
  }
  const sources = [...by].map(([name, visits]) => ({ name, visits })).sort((a, b) => b.visits - a.visits);
  return { visits: sources.reduce((a, s) => a + s.visits, 0), sources };
}

export function makeSource(queryFor: (ctx: Ctx) => Query): Source {
  const collectDays = async (ctx: Ctx, client: Client, from: string, to: string) =>
    saveDays(ctx.db, client.id, await queryFor(ctx)(site(client), from, to, "date", 100));

  const collectMonth = async (ctx: Ctx, client: Client, month: string) => {
    const q = queryFor(ctx);
    const [from, to] = [`${month}-01`, lastDayOf(month)];
    saveMonth(ctx.db, client.id, month, await q(site(client), from, to, "requestPath", TOP), await q(site(client), from, to, "refererHost", TOP));
  };

  return {
    id: SOURCE,
    defaultDay,
    // Default day: rolling window (the last 7 days, while unsampled), so a missed run is made up. Explicit day: only that one.
    collect: (ctx, client, day) => collectDays(ctx, client, day === defaultDay() ? addDays(day, -(WINDOW - 1)) : day, day),
    collectMonthly: collectMonth,

    // from: YYYY-MM. Closed months: daily rows and top lists; the current month: daily rows only. Before the beacon there is simply no data.
    async backfill(ctx, client, from) {
      const current = today().slice(0, 7);
      for (let m = from; m <= current; m = addMonths(m, 1)) {
        const end = m === current ? defaultDay() : lastDayOf(m);
        if (`${m}-01` > end) continue;
        if (ctx.dryRun) {
          console.log(`${client.id} cloudflare napi látogatások ${m}-01..${end}${m < current ? `, top ${TOP} oldal és forrás` : ""}`);
          continue;
        }
        await collectDays(ctx, client, `${m}-01`, end);
        if (m < current) await collectMonth(ctx, client, m);
      }
    },

    async summarize(ctx, client, month) {
      const cur = monthTotals(ctx.db, client.id, month);
      if (!cur) return null;
      const prev = monthTotals(ctx.db, client.id, addMonths(month, -1));
      const daily = ctx.db
        .prepare(
          `SELECT date, sum(CASE metric WHEN 'visits' THEN value END) AS visits, sum(CASE metric WHEN 'pageviews' THEN value END) AS pageviews
           FROM metrics WHERE client_id = ? AND source = 'cloudflare' AND period = 'day' AND date LIKE ? GROUP BY date ORDER BY date`,
        )
        .all(client.id, `${month}-%`);
      const referrers = topList(ctx.db, client.id, month, "referer");
      const prevReferrers = topList(ctx.db, client.id, addMonths(month, -1), "referer");
      const ai = referrers.length ? aiReferrals(referrers) : null;
      const data: Section["data"] = {
        month,
        totals: cur,
        vsPreviousMonth: prev && { visits: pct(cur.visits, prev.visits), pageviews: pct(cur.pageviews, prev.pageviews) },
        daily,
        topPages: topList(ctx.db, client.id, month, "path").slice(0, 10),
        topReferrers: referrers.slice(0, 10),
        // null: no referrer list for the month (not yet collected); the change needs the previous month's list.
        aiReferrals: ai && { ...ai, vsPreviousMonth: prevReferrers.length ? pct(ai.visits, aiReferrals(prevReferrers).visits) : null },
      };
      return { source: SOURCE, data };
    },
  };
}

export const cloudflare = makeSource(() => {
  const env = sourceEnv("cloudflare");
  return createQuery(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID);
});
