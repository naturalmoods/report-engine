import type { Client } from "../core/config.ts";
import { lastDayOf } from "../core/dates.ts";
import { dateTime, duration, html, lineChart, num, pctChange, shortDay, signed, type Html } from "./html.ts";

// Per-source section. New source: add a renderer here, with the sources registry id.
export interface SectionRenderer {
  title: string;
  lead?: string;
  empty: string; // if summarize is null (no data for the month)
  render(data: any, client: Client): Html;
}

const stat = (label: string, value: string, ...changes: (Html | null)[]) =>
  html`<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${changes.map((c) => c && html`<div class="change">${c}</div>`)}</div>`;

// Change with color AND sign/text (color alone carries no meaning).
const delta = (text: string, good: boolean | null) => (good === null ? html`${text}` : html`<span class="${good ? "good" : "bad"}">${text}</span>`);
const ratioDelta = (r: number | null, what: string) => (r == null ? null : html`${delta(pctChange(r), Math.abs(r) < 0.0005 ? null : r > 0)} ${what}`);

// Daily values aligned to the days of the month (missing day = null).
function byDay(month: string, rows: { date: string }[], pick: (r: any) => number | null): (number | null)[] {
  const days = Number(lastDayOf(month).slice(8));
  const map = new Map(rows.map((r) => [r.date, pick(r)]));
  return Array.from({ length: days }, (_, i) => map.get(`${month}-${String(i + 1).padStart(2, "0")}`) ?? null);
}
const chart = (month: string, title: string, values: (number | null)[], unit?: string) =>
  lineChart(title, values, shortDay(`${month}-01`), shortDay(lastDayOf(month)), unit);

type Totals = { clicks: number; impressions: number; ctr: number; position: number };
type Change = { clicks: number | null; impressions: number | null; ctrPoints: number; position: number };
type Top = { key: string; clicks: number; impressions: number; position: number };
type Mover = { key: string; clicks: number; delta: number };
type GscData = {
  month: string;
  totals: Totals;
  vsPreviousMonth: Change | null;
  vsPreviousYear: Change | null;
  daily: { date: string; clicks: number | null; impressions: number | null }[];
  topQueries: Top[];
  topPages: Top[];
  queryMovers: { up: Mover[]; down: Mover[] } | null;
  conversational: { clicks: number; impressionShare: number; shareChangePoints: number | null; top: Top[] } | null;
};

const PREV_M = "az előző hónaphoz képest";
const PREV_Y = "egy évvel korábbihoz képest";

// Position: lower is better.
function positionDelta(c: Change | null, what: string) {
  if (!c) return null;
  const v = Math.round(c.position * 10) / 10;
  if (!v) return html`változatlan ${what}`;
  return html`${delta(`${num(Math.abs(v), 1)} hellyel ${v < 0 ? "előrébb" : "hátrébb"}`, v < 0)} ${what}`;
}
const ctrDelta = (c: Change | null, what: string) => {
  if (!c) return null;
  const v = c.ctrPoints * 100;
  return html`${delta(`${signed(v)} százalékpont`, Math.abs(v) < 0.05 ? null : v > 0)} ${what}`;
};

// Page URL shortened: on the client's own domain only the path.
function shortUrl(u: string, domain: string): string {
  try {
    const x = new URL(u);
    const own = x.host === domain || x.host === `www.${domain}`;
    return (own ? "" : x.host) + decodeURI(x.pathname) + x.search;
  } catch {
    return u;
  }
}

const topTable = (rows: Top[], head: string, key: (t: Top) => string) => html`<table>
<thead><tr><th>${head}</th><th class="n">Kattintás</th><th class="n">Megjelenés</th><th class="n">Pozíció</th></tr></thead>
<tbody>${rows.map((t) => html`<tr><td class="k">${key(t)}</td><td class="n">${num(t.clicks)}</td><td class="n">${num(t.impressions)}</td><td class="n">${num(t.position, 1)}</td></tr>`)}</tbody>
</table>`;

const moverList = (title: string, rows: Mover[], good: boolean) => html`<div><h4>${title}</h4>${
  rows.length
    ? html`<ul class="rows">${rows.map((m) => html`<li><span class="k">${m.key}</span><span class="n">${delta(signed(m.delta, 0), good)}</span></li>`)}</ul>`
    : html`<p class="empty">Nincs ilyen keresés.</p>`
}</div>`;

const gsc: SectionRenderer = {
  title: "Keresési teljesítmény",
  lead: "A Google-keresésben mért adatok, a Search Console alapján.",
  empty: "Erre a hónapra még nincs Search Console-adat.",
  render(d: GscData, client) {
    const { totals: t, vsPreviousMonth: m, vsPreviousYear: y } = d;
    return html`<div class="stats">
${stat("Kattintás", num(t.clicks), m && ratioDelta(m.clicks, PREV_M), y && ratioDelta(y.clicks, PREV_Y))}
${stat("Megjelenés", num(t.impressions), m && ratioDelta(m.impressions, PREV_M), y && ratioDelta(y.impressions, PREV_Y))}
${stat("Átkattintási arány", `${num(t.ctr * 100, 1)}%`, ctrDelta(m, PREV_M))}
${stat("Átlagos pozíció", num(t.position, 1), positionDelta(m, PREV_M))}
</div>
${!m && html`<p class="note">Az előző hónapról nincs adat, ezért összevetés sem készült.</p>`}
${chart(d.month, "Napi kattintások", byDay(d.month, d.daily, (r) => r.clicks))}
${chart(d.month, "Napi megjelenések", byDay(d.month, d.daily, (r) => r.impressions))}
<h3>Leggyakoribb keresések</h3>
${d.topQueries.length ? topTable(d.topQueries, "Keresés", (q) => q.key) : html`<p class="empty">Erre a hónapra még nincs keresési toplista.</p>`}
<h3>Legtöbb kattintást hozó oldalak</h3>
${d.topPages.length ? topTable(d.topPages, "Oldal", (p) => shortUrl(p.key, client.domain)) : html`<p class="empty">Erre a hónapra még nincs oldaltoplista.</p>`}
${d.queryMovers && html`<h3>Legnagyobb változások a kattintásokban</h3>
<div class="cols">${moverList("Növekvő keresések", d.queryMovers.up, true)}${moverList("Csökkenő keresések", d.queryMovers.down, false)}</div>`}
${d.conversational && conversational(d.conversational)}`;
  },
};

// Neutral change (neither good nor bad): a growing share of question-like searches is a trend, not a result.
function conversational(c: NonNullable<GscData["conversational"]>) {
  const ch = c.shareChangePoints == null ? null : html`${signed(c.shareChangePoints * 100)} százalékpont ${PREV_M}`;
  return html`<h3>Kérdés jellegű és hosszabb keresések</h3>
<p class="note">Az AI-alapú keresők terjedésével egyre több keresés teljes kérdés vagy hosszabb mondat. Ide azok tartoznak, amelyek kérdőszóval kezdődnek, kérdőjelet tartalmaznak vagy legalább öt szóból állnak, a hónap leggyakoribb kereséseiből számolva.</p>
<div class="stats">
${stat("Arányuk a megjelenésekben", `${num(c.impressionShare * 100, 1)}%`, ch)}
${stat("Kattintás ezekből", num(c.clicks))}
</div>
${c.top.length ? topTable(c.top, "Keresés", (q) => q.key) : html`<p class="empty">Ebben a hónapban nem volt ilyen keresés a toplistán.</p>`}`;
}

type Visit = { key: string; visits: number; pageviews: number };
type CloudflareData = {
  month: string;
  totals: { visits: number; pageviews: number };
  vsPreviousMonth: { visits: number | null; pageviews: number | null } | null;
  daily: { date: string; visits: number | null; pageviews: number | null }[];
  topPages: Visit[];
  topReferrers: Visit[];
  aiReferrals: { visits: number; sources: { name: string; visits: number }[]; vsPreviousMonth: number | null } | null;
};

const cloudflare: SectionRenderer = {
  title: "Látogatottság",
  lead: "A weboldal valódi látogatói, a Cloudflare Web Analytics mérése alapján, botok nélkül. Becsült értékek.",
  empty: "Erre a hónapra még nincs látogatottsági mérés.",
  render(d: CloudflareData) {
    const m = d.vsPreviousMonth;
    return html`<div class="stats">
${stat("Látogatás", num(d.totals.visits), m && ratioDelta(m.visits, PREV_M))}
${stat("Oldalmegtekintés", num(d.totals.pageviews), m && ratioDelta(m.pageviews, PREV_M))}
${d.aiReferrals && stat("AI asszisztensből érkezett", num(d.aiReferrals.visits), ratioDelta(d.aiReferrals.vsPreviousMonth, PREV_M))}
</div>
${!m && html`<p class="note">Az előző hónapról nincs mérés, ezért összevetés sem készült.</p>`}
${chart(d.month, "Napi látogatások", byDay(d.month, d.daily, (r) => r.visits))}
<h3>Leglátogatottabb oldalak</h3>
${
  d.topPages.length
    ? html`<table>
<thead><tr><th>Oldal</th><th class="n">Megtekintés</th><th class="n">Látogatás</th></tr></thead>
<tbody>${d.topPages.map((p) => html`<tr><td class="k">${decodePath(p.key)}</td><td class="n">${num(p.pageviews)}</td><td class="n">${num(p.visits)}</td></tr>`)}</tbody>
</table>`
    : html`<p class="empty">Erre a hónapra még nincs oldaltoplista.</p>`
}
<h3>Honnan érkeztek a látogatók</h3>
${
  d.topReferrers.length
    ? html`<ul class="rows">${d.topReferrers.map((r) => html`<li><span class="k">${r.key || "Közvetlenül (beírt cím, könyvjelző, alkalmazás)"}</span><span class="n">${num(r.visits)}</span></li>`)}</ul>`
    : html`<p class="empty">Erre a hónapra még nincs forráslista.</p>`
}
${d.aiReferrals && html`<h3>AI asszisztensekből érkező látogatások</h3>
${
  d.aiReferrals.sources.length
    ? html`<ul class="rows">${d.aiReferrals.sources.map((s) => html`<li><span class="k">${s.name}</span><span class="n">${num(s.visits)}</span></li>`)}</ul>`
    : html`<p class="empty">Ebben a hónapban nem érkezett mérhető látogatás AI asszisztensből.</p>`
}
<p class="note">Alsó becslés: több AI-alkalmazás nem adja át, honnan érkezik a látogató, ezek a közvetlen forgalomban jelennek meg.</p>`}`;
  },
};

type AiBot = { token: string; name: string; kind: "search" | "training"; robots: boolean; http: boolean | null };
type AiBotsData = { checkedOn: string; url: string; llmsTxt: boolean; bots: AiBot[]; changes: { day: string; title: string }[] };

const yesNo = (v: boolean | null, yes: string, no: string) => (v === null ? html`–` : html`<span class="${v ? "good" : "bad"}">${v ? yes : no}</span>`);
const botTable = (bots: AiBot[]) => html`<table>
<thead><tr><th>Szolgáltatás</th><th>Robot</th><th>robots.txt</th><th>Kérés</th></tr></thead>
<tbody>${bots.map((b) => html`<tr><td class="k">${b.name}</td><td>${b.token}</td><td>${yesNo(b.robots, "engedi", "tiltja")}</td><td>${yesNo(b.http, "kiszolgálja", "elutasítja")}</td></tr>`)}</tbody>
</table>`;

const aibots: SectionRenderer = {
  title: "AI-keresők hozzáférése",
  lead: "Elérik-e az oldalt a ChatGPT, a Perplexity, a Claude és a Google AI-szolgáltatásainak robotjai. Ha egy kereső robotja ki van tiltva, abban a keresőben az oldal nem jelenhet meg hivatkozott forrásként.",
  empty: "Erre a hónapra még nincs ellenőrzés.",
  render(d: AiBotsData, client) {
    const search = d.bots.filter((b) => b.kind === "search");
    const training = d.bots.filter((b) => b.kind === "training");
    return html`<div class="stats">
${stat("AI-keresők, amelyek elérik az oldalt", `${num(search.filter((b) => b.robots && b.http !== false).length)} / ${num(search.length)}`)}
</div>
<p class="note">Utolsó ellenőrzés: ${shortDay(d.checkedOn)}, ${shortUrl(d.url, client.domain)}</p>
<h3>Keresés és válaszadás</h3>
${botTable(search)}
${training.length > 0 && html`<h3>Modelltanítás</h3>
<p class="note">Ezek a robotok AI-modellek tanításához gyűjtenek. A tiltásuk üzleti döntés, a fenti keresők elérését nem befolyásolja.</p>
${botTable(training)}`}
${d.changes.length > 0 && html`<h3>Változások a hónapban</h3><ul class="rows">${d.changes.map((c) => html`<li><span class="date">${shortDay(c.day)}</span><span class="k">${c.title}</span></li>`)}</ul>`}
<p class="note">A „Kérés” oszlop azt mutatja, kiszolgálja-e a szerver a robot nevével érkező kérést (–: nem ellenőrizzük). Ha egy szolgáltatás a robotokat IP-cím alapján tiltja (például a Cloudflare AI-bot-blokkolása), az innen nem látszik. Az oldalon ${d.llmsTxt ? "van" : "nincs"} llms.txt fájl (ez egy javasolt, nem szabványos formátum az AI-eszközöknek).</p>`;
  },
};

function decodePath(p: string): string {
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

type UptimeData = {
  month: string;
  availabilityPct: number;
  downtimes: { url: string; start: string; end: string | null; seconds: number; ongoing?: boolean }[];
  downtimeSeconds: number;
  daily: { date: string; avgResponseMs: number | null }[];
};

const uptime: SectionRenderer = {
  title: "Elérhetőség",
  lead: "Az oldal ötpercenkénti automatikus ellenőrzése alapján.",
  empty: "Erre a hónapra még nincs elérhetőségi mérés.",
  render(d: UptimeData, client) {
    // Rounded down: 99.996% must not show as 100%.
    const avail = Math.floor(d.availabilityPct * 100) / 100;
    return html`<div class="stats">
${stat("Rendelkezésre állás", `${num(avail, 2)}%`)}
${stat("Leállások száma", num(d.downtimes.length))}
${stat("Leállási idő összesen", d.downtimes.length ? duration(d.downtimeSeconds) : "0 perc")}
</div>
${chart(d.month, "Átlagos napi válaszidő", byDay(d.month, d.daily, (r) => r.avgResponseMs), " ms")}
<h3>Leállások</h3>
${
  d.downtimes.length
    ? html`<table>
<thead><tr><th>Oldal</th><th>Kezdete</th><th class="n">Időtartam</th></tr></thead>
<tbody>${d.downtimes.map((x) => html`<tr><td class="k">${shortUrl(x.url, client.domain)}</td><td>${dateTime(x.start)}</td><td class="n">${duration(x.seconds)}${x.ongoing && html`<br><span class="bad">a hónap végén még tartott</span>`}</td></tr>`)}</tbody>
</table>`
    : html`<p class="empty">A hónapban nem volt leállás.</p>`
}`;
  },
};

type WorkEvent = { date: string; title: string; minutes?: number | null };
type WorklogData = { month: string; counts: Record<string, number>; manualMinutes: number; events: Record<string, WorkEvent[]> };
const MAX_COMMITS = 20;

const item = (e: WorkEvent, extra?: string) =>
  html`<li><span class="date">${shortDay(e.date)}</span><span class="k">${e.title}</span>${extra && html`<span class="n">${extra}</span>`}</li>`;

const worklog: SectionRenderer = {
  title: "Elvégzett munka",
  empty: "Erre a hónapra nincs rögzített munka vagy kódváltozás.",
  render(d: WorklogData) {
    const manual = d.events.manual ?? [];
    const commits = d.events.commit ?? [];
    const merges = d.counts.merge ?? 0, bots = d.counts.bot ?? 0;
    const other = [merges && `${num(merges)} összevonás (merge)`, bots && `${num(bots)} automatikus frissítés`].filter(Boolean).join(" és ");
    return html`<div class="stats">
${stat("Munkabejegyzés", num(manual.length))}
${d.manualMinutes > 0 && stat("Rögzített munkaidő", duration(d.manualMinutes * 60))}
${stat("Kódváltozás", num(commits.length))}
</div>
${manual.length > 0 && html`<h3>Munkabejegyzések</h3><ul class="rows">${manual.map((e) => item(e, e.minutes ? duration(e.minutes * 60) : undefined))}</ul>`}
${commits.length > 0 && html`<h3>Kódváltozások</h3><ul class="rows">${commits.slice(0, MAX_COMMITS).map((e) => item(e))}</ul>
${commits.length > MAX_COMMITS && html`<p class="note">és további ${num(commits.length - MAX_COMMITS)} kódváltozás.</p>`}`}
${other && html`<p class="note">Ezen felül ${other} történt a kódtárban.</p>`}`;
  },
};

export const renderers: Record<string, SectionRenderer> = { gsc, cloudflare, aibots, uptime, worklog };
