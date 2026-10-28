import { readFileSync } from "node:fs";
import type { Client } from "../core/config.ts";
import type { Section } from "../sources/types.ts";
import type { AiText } from "./ai.ts";
import { duration, html, monthName, num, pctChange, type Html } from "./html.ts";

// The email is built at report time, from the same data and AI text as the page, and written to a file (email.json):
// send sends that, no regeneration. URL_PLACEHOLDER stands in place of the report URL; the URL is decided at send time (token + month).
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}
export const URL_PLACEHOLDER = "{{URL}}";

// Skeleton precompiled from MJML (scripts/build-email.ts); only the {{KEY}} places are filled in.
const SHELL = readFileSync(new URL("./templates/email/email.html", import.meta.url), "utf8");
// Single pass: a {{...}} inside the inserted data is not substituted again, {{URL}} stays untouched.
const fill = (tpl: string, vals: Record<string, string>) => tpl.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => vals[k] ?? m);

const MAX_WORK = 5;
const PREV_M = "az előző hónaphoz képest";
// Reliable in mail clients, table cells; the color is handled by the skeleton's dark-mode rules.
const cell = (label: string, value: string, change?: string) => html`<td width="50%" valign="top" style="padding:0 8px 16px 0;">
<div style="font-size:13px;color:#5b636d;">${label}</div>
<div style="font-size:24px;line-height:1.2;font-weight:bold;">${value}</div>
${change && html`<div style="font-size:12px;color:#5b636d;">${change}</div>`}
</td>`;

export function buildEmail(client: Client, month: string, sections: [string, Section | null][], ai?: AiText, brand?: string): EmailContent {
  const d = Object.fromEntries(sections.map(([id, s]) => [id, s?.data as any]));
  const { gsc, cloudflare, uptime, worklog } = d;
  const ratio = (r: number | null | undefined) => (r == null ? undefined : `${pctChange(r)} ${PREV_M}`);
  // 3–5 key numbers: those that have data.
  const stats: [string, string, string?][] = [];
  if (gsc) {
    stats.push(["Kattintás a keresőből", num(gsc.totals.clicks), ratio(gsc.vsPreviousMonth?.clicks)]);
    stats.push(["Megjelenés a keresőben", num(gsc.totals.impressions), ratio(gsc.vsPreviousMonth?.impressions)]);
  }
  if (cloudflare) stats.push(["Látogatás az oldalon", num(cloudflare.totals.visits), ratio(cloudflare.vsPreviousMonth?.visits)]);
  if (uptime) stats.push(["Rendelkezésre állás", `${num(Math.floor(uptime.availabilityPct * 100) / 100, 2)}%`, uptime.downtimes.length ? `${num(uptime.downtimes.length)} leállás, ${duration(uptime.downtimeSeconds)}` : "nem volt leállás"]);
  const manual: { title: string }[] = worklog?.events.manual ?? [];
  const commits: unknown[] = worklog?.events.commit ?? [];
  if (worklog) stats.push(["Elvégzett munka", `${num(manual.length + commits.length)} tétel`, `${num(manual.length)} bejegyzés, ${num(commits.length)} kódváltozás`]);

  // Work list: the AI's client-language list; without it the manual entries (commit titles are technical, they do not go to the client).
  const work = (ai?.workItems ?? manual.map((m) => m.title)).slice(0, MAX_WORK);
  const rows = Array.from({ length: Math.ceil(stats.length / 2) }, (_, i) => stats.slice(i * 2, i * 2 + 2));
  const period = monthName(month);
  const statsHtml = rows.length ? html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map((r) => html`<tr>${r.map((c) => cell(...c))}${r.length < 2 && html`<td width="50%"></td>`}</tr>`)}</table>` : null;
  const workHtml = work.length ? html`<div style="font-weight:bold;padding-bottom:6px;">A hónap munkái</div><ul style="margin:0;padding-left:20px;">${work.map((w) => html`<li style="padding-bottom:4px;">${w}</li>`)}</ul>` : null;
  const footer = `Az email a ${client.domain} havi riportjáról szól.${ai ? " Az összefoglalót AI segítségével készítettük, emberi jóváhagyással." : ""}`;

  const subject = `${client.name}: havi riport, ${period}`;
  const e = (h?: Html | null) => h?.__html ?? "";
  const text = [
    subject,
    ...(ai ? ["", ai.summary] : []),
    ...(stats.length ? ["", ...stats.map(([l, v, c]) => `${l}: ${v}${c ? ` (${c})` : ""}`)] : []),
    ...(work.length ? ["", "A hónap munkái:", ...work.map((w) => `- ${w}`)] : []),
    "",
    `Teljes riport: ${URL_PLACEHOLDER}`,
    "",
    ...(brand ? [brand] : []),
    footer,
    "",
  ].join("\n");
  return {
    subject,
    text,
    html: fill(SHELL, {
      TITLE: e(html`${subject}`),
      HEADER: e(html`${brand ? `${brand} · havi riport` : "Havi riport"}`),
      PREVIEW: e(html`${ai?.summary.slice(0, 120) ?? `${client.name} havi riportja elkészült.`}`),
      CLIENT: e(html`${client.name}`),
      PERIOD: e(html`Havi riport, ${period}`),
      SUMMARY: e(ai && html`<div style="font-size:16px;">${ai.summary}</div>`),
      STATS: e(statsHtml),
      WORK: e(workHtml),
      FOOTER: e(html`${footer}`),
    }),
  };
}

// At send time: the URL is put in its place (no HTML-special characters in the URL: the token is base64url, the month is digits).
export const withUrl = (c: EmailContent, url: string, subjectPrefix = ""): EmailContent => ({
  subject: subjectPrefix + c.subject,
  html: c.html.split(URL_PLACEHOLDER).join(url),
  text: c.text.split(URL_PLACEHOLDER).join(url),
});
