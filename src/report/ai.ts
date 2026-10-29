import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import * as z from "zod";
import type { Client } from "../core/config.ts";
import type { Section } from "../sources/types.ts";
import { duration } from "./html.ts";

// LLM adapter: system prompt + input → the model's reply as JSON text (validation happens here, not in the adapter,
// so malformed JSON and schema errors take the same retry path).
export interface Llm {
  generate(system: string, input: string): Promise<string>;
}

export const AiText = z.object({
  workItems: z.array(z.string().min(1)).max(8),
  summary: z.string().min(1),
  suggestions: z.array(z.string().min(1)).max(3),
});
export type AiText = z.infer<typeof AiText>;

// ok: AI text present; failed: still not valid after two attempts; skipped: not requested (no --live).
export type AiStatus = "ok" | "failed" | "skipped";
export type AiResult = { status: "ok"; text: AiText } | { status: "failed"; error: string };

// Open core: the own (private) prompt under config/prompts/ overrides the generic base version in the repo.
const prompt = (file: string) => {
  const own = join("config/prompts", file);
  return readFileSync(existsSync(own) ? own : new URL(`./prompts/${file}`, import.meta.url), "utf8");
};
export const SYSTEM = ["rules.md", "worklog.md", "summary.md"].map(prompt).join("\n\n");

export function anthropicLlm(env: Record<string, string>): Llm {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // Structured output: the API binds the reply to the schema; the transform moves unsupported constraints (maxItems, minLength)
  // into the description, and the zod schema checks them afterwards.
  const { type, schema } = jsonSchemaOutputFormat(z.toJSONSchema(AiText) as { type: "object" });
  return {
    async generate(system, input) {
      const res = await client.messages.create({
        model: env.LLM_MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: input }],
        output_config: { format: { type, schema } },
      });
      if (res.stop_reason !== "end_turn") throw new Error(`a modell válasza nem teljes (stop_reason: ${res.stop_reason})`);
      return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    },
  };
}

// --- Input: compact JSON from the sections, changes precomputed (so the model does not have to calculate). ---

const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (ratio: number | null) => (ratio == null ? null : r1(ratio * 100));
const changes = (c: any) =>
  c && { clicksPct: pct(c.clicks), impressionsPct: pct(c.impressions), ctrPoints: r1(c.ctrPoints * 100), positionChange: r1(c.position) };
const MAX_COMMITS = 100;

export function aiInput(client: Client, month: string, sections: [string, Section | null][]) {
  const d = Object.fromEntries(sections.map(([id, s]) => [id, s?.data as any]));
  const { gsc, cloudflare, aibots, uptime, worklog } = d;
  const reachable = (b: any) => b.robots && b.http !== false;
  const blocked = (kind: string) => aibots?.bots.filter((b: any) => b.kind === kind && !reachable(b)).map((b: any) => `${b.name} (${b.token})`);
  const commits = worklog?.events.commit ?? [];
  const manual = worklog?.events.manual ?? [];
  return {
    client: client.name,
    domain: client.domain,
    month,
    formality: client.report?.formality ?? "magazo",
    search: gsc && {
      clicks: gsc.totals.clicks,
      impressions: gsc.totals.impressions,
      ctrPct: r1(gsc.totals.ctr * 100),
      avgPosition: r1(gsc.totals.position),
      vsPreviousMonth: changes(gsc.vsPreviousMonth),
      vsPreviousYear: changes(gsc.vsPreviousYear),
      topQueries: gsc.topQueries.slice(0, 5).map((q: any) => ({ query: q.key, clicks: q.clicks })),
      topPages: gsc.topPages.slice(0, 5).map((p: any) => ({ page: p.key, clicks: p.clicks })),
      risingQueries: gsc.queryMovers?.up.slice(0, 3).map((m: any) => ({ query: m.key, clicksChange: m.delta })),
      fallingQueries: gsc.queryMovers?.down.slice(0, 3).map((m: any) => ({ query: m.key, clicksChange: m.delta })),
      questionQueries: gsc.conversational && {
        impressionSharePct: r1(gsc.conversational.impressionShare * 100),
        shareChangePoints: gsc.conversational.shareChangePoints == null ? null : r1(gsc.conversational.shareChangePoints * 100),
        clicks: gsc.conversational.clicks,
        examples: gsc.conversational.top.slice(0, 3).map((q: any) => ({ query: q.key, impressions: q.impressions })),
      },
    },
    traffic: cloudflare && {
      visits: cloudflare.totals.visits,
      pageViews: cloudflare.totals.pageviews,
      vsPreviousMonth: cloudflare.vsPreviousMonth && { visitsPct: pct(cloudflare.vsPreviousMonth.visits), pageViewsPct: pct(cloudflare.vsPreviousMonth.pageviews) },
      topPages: cloudflare.topPages.slice(0, 5).map((p: any) => ({ page: p.key, pageViews: p.pageviews })),
      topReferrers: cloudflare.topReferrers.slice(0, 5).map((r: any) => ({ source: r.key || "direct", visits: r.visits })),
      aiAssistantVisits: cloudflare.aiReferrals && {
        visits: cloudflare.aiReferrals.visits,
        vsPreviousMonthPct: pct(cloudflare.aiReferrals.vsPreviousMonth),
        bySource: cloudflare.aiReferrals.sources,
      },
    },
    aiAccess: aibots && {
      blockedSearchBots: blocked("search"),
      blockedTrainingBots: blocked("training"),
      changes: aibots.changes.map((c: any) => ({ date: c.day, text: c.title })),
      llmsTxt: aibots.llmsTxt,
    },
    availability: uptime && {
      availabilityPct: Math.floor(uptime.availabilityPct * 100) / 100, // as in the report: rounded down
      downtimeCount: uptime.downtimes.length,
      downtimeTotal: uptime.downtimes.length ? duration(uptime.downtimeSeconds) : null,
    },
    work: worklog && {
      manualEntryCount: manual.length,
      manualTimeTotal: worklog.manualMinutes > 0 ? duration(worklog.manualMinutes * 60) : null,
      manualEntries: manual.map((e: any) => ({ date: e.date, text: e.title, time: e.minutes ? duration(e.minutes * 60) : null })),
      commitCount: commits.length,
      commits: commits.slice(0, MAX_COMMITS).map((e: any) => ({ date: e.date, title: e.title })),
      merges: worklog.counts.merge ?? 0,
      automaticUpdates: worklog.counts.bot ?? 0,
    },
  };
}

// --- Number check ---

// A number in the text: value and rounding tolerance (half of the last printed decimal place). Hungarian format: decimal comma
// (a dot is also taken as decimal), thousands grouping with space / NBSP / narrow NBSP, „ezer”/„millió” multiplier.
// Unsigned: „−4,0%” and „4%-kal csökkent” are the same number.
const NUM = /(?<![\d.,])(\d{1,3}(?:[   ]\d{3}(?!\d))+|\d+)(?:[.,](\d+))?(?:\s*(ezer|millió|milliárd)(?![a-zá-ű]))?/gi;
const MULT: Record<string, number> = { ezer: 1e3, millió: 1e6, milliárd: 1e9 };

export function numbersIn(text: string): { text: string; value: number; tol: number }[] {
  // 2026.09.05 → three separate numbers (otherwise 2026,09 would look like a decimal).
  const t = text.replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/g, "$1 / $2 / $3");
  return [...t.matchAll(NUM)].map((m) => {
    const mult = m[3] ? MULT[m[3].toLowerCase()] : 1;
    const decimals = m[2]?.length ?? 0;
    return { text: m[0], value: Number(`${m[1].replace(/\D/g, "")}.${m[2] ?? 0}`) * mult, tol: (0.5 * mult) / 10 ** decimals };
  });
}

// Every number of the input: the numeric fields and the numbers occurring in texts (date, title, duration).
function inputNumbers(v: unknown): number[] {
  if (typeof v === "number") return [Math.abs(v)];
  if (typeof v === "string") return numbersIn(v).map((n) => n.value);
  if (v && typeof v === "object") return Object.values(v).flatMap(inputNumbers);
  return [];
}

export function unknownNumbers(texts: string[], input: unknown): string[] {
  const allowed = inputNumbers(input);
  return texts.flatMap(numbersIn).filter((n) => !allowed.some((x) => Math.abs(x - n.value) <= n.tol + 1e-9)).map((n) => n.text);
}

function validate(raw: string, input: unknown): AiText {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("a válasz nem érvényes JSON");
  }
  const r = AiText.safeParse(json);
  if (!r.success) throw new Error(`a válasz nem felel meg a sémának: ${r.error.issues.map((i) => `${i.path.join(".") || "(gyökér)"}: ${i.message}`).join("; ")}`);
  const texts = [...r.data.workItems, r.data.summary, ...r.data.suggestions];
  const bad = unknownNumbers(texts, input);
  if (bad.length) throw new Error(`a szövegben a bemenetben nem szereplő szám van: ${bad.join(", ")}`);
  if (texts.some((s) => /AI[-‐‑–]asszisztens/i.test(s))) throw new Error("„AI asszisztens” kötőjel nélkül írandó");
  return r.data;
}

// One attempt, on error one more with the error description; if that fails too, failed (the report is built without AI text).
export async function writeAi(llm: Llm, input: unknown): Promise<AiResult> {
  const data = `<adatok>\n${JSON.stringify(input, null, 2)}\n</adatok>`;
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await llm.generate(SYSTEM, error ? `${data}\n\nAz előző válaszod hibás volt (${error}). Adj javított választ.` : data);
      return { status: "ok", text: validate(raw, input) };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { status: "failed", error };
}
