import { addDays, addMonths, lastDayOf, today } from "../../core/dates.ts";
import { sourceEnv } from "../../core/env.ts";
import type { Db } from "../../core/db.ts";
import type { Client, Ctx, Section, Source } from "../types.ts";
import { createQuery, type Query, type Row } from "./api.ts";

// Search Console days are in the Pacific time zone (PT). We do not convert: the date is stored
// as GSC gives it, and queries also send a PT date.
const SOURCE = "gsc";
const TOP = 500;
// GSC finalizes with a 2-3 day delay.
const defaultDay = () => addDays(today(), -3);
const prop = (c: Client) => c.sources.gsc!.property;

const UPSERT = `INSERT INTO metrics (client_id, source, metric, dimension, period, date, value)
  VALUES (?, 'gsc', ?, ?, ?, ?, ?)
  ON CONFLICT (client_id, source, metric, dimension, period, date) DO UPDATE SET value = excluded.value`;

function saveDays(db: Db, clientId: string, rows: Row[]): void {
  const up = db.prepare(UPSERT);
  db.transaction(() => {
    for (const r of rows) {
      const m = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
      for (const [k, v] of Object.entries(m)) up.run(clientId, k, "", "day", r.keys[0], v);
    }
  })();
}

// A rerun leaves no stale row: delete first, then insert, in one transaction.
function saveMonth(db: Db, clientId: string, month: string, queries: Row[], pages: Row[]): void {
  const up = db.prepare(UPSERT);
  db.transaction(() => {
    db.prepare("DELETE FROM metrics WHERE client_id = ? AND source = 'gsc' AND period = 'month' AND date = ?").run(clientId, month);
    for (const [prefix, rows] of [["query", queries], ["page", pages]] as const) {
      for (const r of rows) {
        const dim = `${prefix}:${r.keys[0]}`;
        up.run(clientId, "clicks", dim, "month", month, r.clicks);
        up.run(clientId, "impressions", dim, "month", month, r.impressions);
        up.run(clientId, "position", dim, "month", month, r.position);
      }
    }
  })();
}

type Totals = { clicks: number; impressions: number; ctr: number; position: number };

// Monthly aggregate from the daily rows. CTR = total clicks / total impressions, position is the
// impression-weighted average (sum(position × impressions) / sum(impressions)), not the average of daily values.
export function monthTotals(db: Db, clientId: string, month: string): Totals | null {
  const rows = db
    .prepare(
      `SELECT date, metric, value FROM metrics WHERE client_id = ? AND source = 'gsc' AND period = 'day'
       AND date LIKE ? AND metric IN ('clicks', 'impressions', 'position')`,
    )
    .all(clientId, `${month}-%`) as { date: string; metric: string; value: number }[];
  if (!rows.length) return null;
  const days = new Map<string, Record<string, number>>();
  for (const r of rows) days.set(r.date, { ...days.get(r.date), [r.metric]: r.value });
  let clicks = 0, impressions = 0, weighted = 0;
  for (const d of days.values()) {
    clicks += d.clicks ?? 0;
    impressions += d.impressions ?? 0;
    weighted += (d.position ?? 0) * (d.impressions ?? 0);
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? weighted / impressions : 0,
  };
}

const pct = (cur: number, prev: number | undefined) => (prev ? (cur - prev) / prev : null);

function change(cur: Totals, prev: Totals | null) {
  if (!prev) return null;
  return {
    clicks: pct(cur.clicks, prev.clicks),
    impressions: pct(cur.impressions, prev.impressions),
    ctrPoints: cur.ctr - prev.ctr,
    // Negative value = improving (smaller) position.
    position: cur.position - prev.position,
  };
}

type Top = { key: string; clicks: number; impressions: number; position: number };

function topList(db: Db, clientId: string, month: string, prefix: "query" | "page"): Top[] {
  const rows = db
    .prepare(
      `SELECT dimension, metric, value FROM metrics WHERE client_id = ? AND source = 'gsc' AND period = 'month'
       AND date = ? AND dimension LIKE ?`,
    )
    .all(clientId, month, `${prefix}:%`) as { dimension: string; metric: string; value: number }[];
  const by = new Map<string, Top>();
  for (const r of rows) {
    const key = r.dimension.slice(prefix.length + 1);
    by.set(key, { ...(by.get(key) ?? { key, clicks: 0, impressions: 0, position: 0 }), [r.metric]: r.value });
  }
  return [...by.values()].sort((a, b) => b.clicks - a.clicks);
}

// Change in clicks versus the previous month; new and disappeared items count too.
function movers(cur: Top[], prev: Top[]) {
  const before = new Map(prev.map((t) => [t.key, t.clicks]));
  const seen = new Set(cur.map((t) => t.key));
  const deltas = [
    ...cur.map((t) => ({ key: t.key, clicks: t.clicks, delta: t.clicks - (before.get(t.key) ?? 0) })),
    ...prev.filter((t) => !seen.has(t.key)).map((t) => ({ key: t.key, clicks: 0, delta: -t.clicks })),
  ];
  return {
    up: deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5),
    down: deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
  };
}

// Question-like or long (conversational) queries: starts with a question word, contains "?", or has at least 5 words.
// Computed from the monthly top list only (anonymized queries are not in it), so the share is of the top list's impressions.
const QUESTION_WORDS = new Set(
  ("hogyan hogy mi mit mik miért mikor hol hova hová honnan meddig melyik melyiket mennyi mennyibe mekkora milyen ki kik kinek mire mivel lehet kell érdemes " +
    "how what why when where which who can is are does do should").split(" "),
);
export const isConversational = (q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 5 || QUESTION_WORDS.has(words[0]) || q.includes("?");
};

function conversational(queries: Top[]) {
  if (!queries.length) return null;
  const hits = queries.filter((q) => isConversational(q.key));
  const all = queries.reduce((a, q) => a + q.impressions, 0);
  const impressions = hits.reduce((a, q) => a + q.impressions, 0);
  return {
    queries: hits.length,
    clicks: hits.reduce((a, q) => a + q.clicks, 0),
    impressions,
    impressionShare: all ? impressions / all : 0,
    top: [...hits].sort((a, b) => b.impressions - a.impressions).slice(0, 5),
  };
}

export function makeSource(queryFor: (ctx: Ctx) => Query): Source {
  const collectDays = async (ctx: Ctx, client: Client, start: string, end: string) =>
    saveDays(ctx.db, client.id, await queryFor(ctx)(prop(client), { startDate: start, endDate: end, dimensions: ["date"] }));

  const collectMonth = async (ctx: Ctx, client: Client, month: string) => {
    const q = queryFor(ctx);
    const range = { startDate: `${month}-01`, endDate: lastDayOf(month), rowLimit: TOP };
    const queries = await q(prop(client), { ...range, dimensions: ["query"] });
    const pages = await q(prop(client), { ...range, dimensions: ["page"] });
    saveMonth(ctx.db, client.id, month, queries, pages);
  };

  return {
    id: SOURCE,
    defaultDay,
    // Default day (no --day): rolling 5-day window (defaultDay−4..defaultDay), so a missed/not-yet-final day is made up by the next run. Explicit day: only that one.
    collect: (ctx, client, day) => collectDays(ctx, client, day === defaultDay() ? addDays(day, -4) : day, day),
    collectMonthly: collectMonth,

    // from: YYYY-MM. For closed months daily rows and top lists, for the current month only the daily rows (up to today − 3).
    async backfill(ctx, client, from) {
      const current = today().slice(0, 7);
      const lastDay = defaultDay();
      for (let m = from; m <= current; m = addMonths(m, 1)) {
        const end = m === current ? lastDay : lastDayOf(m);
        if (`${m}-01` > end) continue;
        if (ctx.dryRun) {
          console.log(`${client.id} gsc napi összesítők ${m}-01..${end}`);
          if (m < current) console.log(`${client.id} gsc top ${TOP} lekérdezés és oldal ${m}`);
          continue;
        }
        await collectDays(ctx, client, `${m}-01`, end);
        if (m < current) await collectMonth(ctx, client, m);
      }
    },

    async summarize(ctx, client, month) {
      const cur = monthTotals(ctx.db, client.id, month);
      if (!cur) return null;
      const prevMonth = addMonths(month, -1);
      const prev = monthTotals(ctx.db, client.id, prevMonth);
      const lastYear = monthTotals(ctx.db, client.id, addMonths(month, -12));
      const queries = topList(ctx.db, client.id, month, "query");
      const pages = topList(ctx.db, client.id, month, "page");
      // Without the previous month's top list there is no meaningful comparison (movers = null).
      const prevQueries = topList(ctx.db, client.id, prevMonth, "query");
      const prevPages = topList(ctx.db, client.id, prevMonth, "page");
      const series = ctx.db
        .prepare(
          `SELECT date, sum(CASE metric WHEN 'clicks' THEN value END) AS clicks,
                  sum(CASE metric WHEN 'impressions' THEN value END) AS impressions
           FROM metrics WHERE client_id = ? AND source = 'gsc' AND period = 'day' AND date LIKE ?
           GROUP BY date ORDER BY date`,
        )
        .all(client.id, `${month}-%`);
      const data: Section["data"] = {
        month,
        totals: cur,
        vsPreviousMonth: change(cur, prev),
        vsPreviousYear: change(cur, lastYear),
        daily: series,
        topQueries: queries.slice(0, 10),
        topPages: pages.slice(0, 10),
        queryMovers: prevQueries.length ? movers(queries, prevQueries) : null,
        pageMovers: prevPages.length ? movers(pages, prevPages) : null,
      };
      const conv = conversational(queries), prevConv = conversational(prevQueries);
      data.conversational = conv && { ...conv, shareChangePoints: prevConv ? conv.impressionShare - prevConv.impressionShare : null };
      return { source: SOURCE, data };
    },
  };
}

export const gsc = makeSource(() => createQuery(sourceEnv("gsc").GOOGLE_APPLICATION_CREDENTIALS));
