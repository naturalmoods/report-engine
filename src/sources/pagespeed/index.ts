import { addMonths, today } from "../../core/dates.ts";
import type { Db } from "../../core/db.ts";
import { sourceEnv } from "../../core/env.ts";
import type { Client, Section, Source } from "../types.ts";

// PageSpeed Insights API v5 (GET pagespeedonline/v5/runPagespeed, strategy=mobile, category=performance), once a day per URL.
// Lab (Lighthouse): performance score and LCP/CLS/TBT from lighthouseResult.audits[...].numericValue; noisy from run to run,
// so the month is the median of the daily runs. Field (CrUX, real Chrome users, rolling 28 days): originLoadingExperience
// percentiles, taken from the month's last run; small sites often have none. The CrUX metric keys are not in the reference page
// (only in examples); checked against a live response on 2026-10-29. The API key is in the query string: it must not reach an error message.
const SOURCE = "pagespeed";
const TIMEOUT_MS = 120_000;
const AUDITS = { lcp_ms: "largest-contentful-paint", cls: "cumulative-layout-shift", tbt_ms: "total-blocking-time" } as const;
const FIELD = { field_lcp_ms: "LARGEST_CONTENTFUL_PAINT_MS", field_inp_ms: "INTERACTION_TO_NEXT_PAINT", field_cls: "CUMULATIVE_LAYOUT_SHIFT_SCORE" } as const;

export type Psi = {
  lighthouseResult?: {
    categories?: { performance?: { score: number | null } };
    audits?: Record<string, { numericValue?: number }>;
    runtimeError?: { code?: string; message?: string };
  };
  originLoadingExperience?: { metrics?: Record<string, { percentile?: number }> };
};
export type Run = (url: string) => Promise<Psi>;

export function createRun(key: string, f: typeof fetch = fetch): Run {
  return async (url) => {
    const q = new URLSearchParams({ url, strategy: "mobile", category: "performance", key });
    const res = await f(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as (Psi & { error?: { message?: string } }) | null;
    if (!res.ok) throw new Error(`PageSpeed API hiba: HTTP ${res.status} ${body?.error?.message ?? ""}`.trim());
    return body ?? {};
  };
}

const urlsOf = (c: Client) => c.sources.pagespeed!.urls ?? [`https://${c.domain}/`];

// Lab metrics with dimension = URL, field metrics with dimension = "origin:<origin>" (the same for every URL of the site).
function metricsOf(url: string, r: Psi): [string, string, number][] {
  const lr = r.lighthouseResult;
  if (lr?.runtimeError?.code) throw new Error(`Lighthouse-hiba: ${lr.runtimeError.code}`);
  const score = lr?.categories?.performance?.score;
  if (score == null) throw new Error("nincs teljesítménypontszám a válaszban");
  const out: [string, string, number][] = [["score", url, Math.round(score * 100)]];
  for (const [m, a] of Object.entries(AUDITS)) {
    const v = lr?.audits?.[a]?.numericValue;
    if (v != null) out.push([m, url, v]);
  }
  const origin = `origin:${new URL(url).origin}`;
  for (const [m, k] of Object.entries(FIELD)) {
    const p = r.originLoadingExperience?.metrics?.[k]?.percentile;
    // CLS percentile comes multiplied by 100 (e.g. 5 = 0.05).
    if (p != null) out.push([m, origin, m === "field_cls" ? p / 100 : p]);
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

type Row = { date: string; metric: string; dimension: string; value: number };
const monthRows = (db: Db, clientId: string, month: string) =>
  db.prepare("SELECT date, metric, dimension, value FROM metrics WHERE client_id = ? AND source = 'pagespeed' AND period = 'day' AND date LIKE ?").all(clientId, `${month}-%`) as Row[];

function labMedians(rows: Row[], url: string) {
  const of = (m: string) => rows.filter((r) => r.dimension === url && r.metric === m).map((r) => r.value);
  const med = (m: string) => (of(m).length ? median(of(m)) : null);
  return { score: med("score"), lcpMs: med("lcp_ms"), cls: med("cls"), tbtMs: med("tbt_ms"), days: of("score").length };
}

export interface Deps {
  run?: (ctx: { env: Record<string, string> }) => Run;
  now?: () => Date;
}

export function makeSource(deps: Deps = {}): Source {
  const runFor = deps.run ?? (() => createRun(sourceEnv("pagespeed").PAGESPEED_API_KEY));
  const now = deps.now ?? (() => new Date());
  return {
    id: SOURCE,
    defaultDay: () => today(now()),

    // A snapshot of today: a past --day is skipped. One URL failing does not stop the rest; the run fails at the end.
    async collect(ctx, client, day) {
      if (day !== today(now())) return console.log(`${client.id} pagespeed: csak a mai állapotot méri, ${day} kimarad`);
      const run = runFor(ctx);
      const up = ctx.db.prepare(`INSERT INTO metrics (client_id, source, metric, dimension, period, date, value) VALUES (?, 'pagespeed', ?, ?, 'day', ?, ?)
        ON CONFLICT (client_id, source, metric, dimension, period, date) DO UPDATE SET value = excluded.value`);
      const errors: string[] = [];
      for (const url of urlsOf(client)) {
        try {
          const ms = metricsOf(url, await run(url));
          ctx.db.transaction(() => ms.forEach(([m, d, v]) => up.run(client.id, m, d, day, v)))();
        } catch (e) {
          errors.push(`${url}: ${(e as Error).message}`);
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
    },

    async summarize(ctx, client, month) {
      const rows = monthRows(ctx.db, client.id, month);
      if (!rows.length) return null;
      const prev = monthRows(ctx.db, client.id, addMonths(month, -1));
      const pages = urlsOf(client)
        .map((url) => {
          const cur = labMedians(rows, url), before = labMedians(prev, url);
          return { url, ...cur, scoreChange: cur.score != null && before.score != null ? cur.score - before.score : null };
        })
        .filter((p) => p.days > 0);
      // Field data: the month's last day that has any.
      const fieldDay = rows.filter((r) => r.dimension.startsWith("origin:")).reduce((m, r) => (r.date > m ? r.date : m), "");
      const f = (m: string) => rows.find((r) => r.date === fieldDay && r.metric === m)?.value ?? null;
      const field = fieldDay ? { date: fieldDay, lcpMs: f("field_lcp_ms"), inpMs: f("field_inp_ms"), cls: f("field_cls") } : null;
      const data: Section["data"] = { month, pages, field };
      return { source: SOURCE, data };
    },
  };
}

export const pagespeed = makeSource();
