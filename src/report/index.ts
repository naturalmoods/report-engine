import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "../core/config.ts";
import { registry } from "../sources/registry.ts";
import { log } from "../core/log.ts";
import type { Ctx, Section } from "../sources/types.ts";
import { aiInput, writeAi, type AiResult, type AiStatus, type AiText, type Llm } from "./ai.ts";
import { buildEmail } from "./email.ts";
import { html, longDate, monthName, raw } from "./html.ts";
import { renderers } from "./sections.ts";

export interface RenderOptions {
  now: Date; // time of generation (fixed in tests)
  ai?: AiText; // AI text: separate block at the start of the report + AI marker in the footer
  preview?: string[]; // only in the draft preview: warning bar with these lines (not in the client version)
  brand?: string; // agency name (BRAND_NAME); omitted when unset
}

const CSS = `
:root{--bg:#fff;--fg:#17191c;--muted:#626873;--line:#e3e5e8;--soft:#f5f6f8;--accent:#2f5bd3;--good:#18794e;--bad:#c4332b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e6e8eb;--muted:#99a0aa;--line:#2b2f36;--soft:#1a1d22;--accent:#86a2ff;--good:#4cc38a;--bad:#ff8077}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 3rem}
.brand{font-weight:650;letter-spacing:-.01em;margin:0 0 2.5rem}
h1{font-size:clamp(1.625rem,5vw,2.125rem);line-height:1.15;letter-spacing:-.02em;font-weight:650;margin:0 0 .5rem}
.sub{color:var(--muted);margin:0}
section{border-top:1px solid var(--line);margin-top:2.5rem;padding-top:2rem}
h2{font-size:1.375rem;line-height:1.25;letter-spacing:-.01em;font-weight:620;margin:0 0 .25rem}
h3{font-size:1rem;font-weight:600;margin:2.25rem 0 .75rem}
h4{font-size:.875rem;font-weight:600;margin:0 0 .5rem}
p{margin:0 0 1rem}
.lead{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:1.5rem;margin:1.5rem 0 2rem}
.label{font-size:.8125rem;color:var(--muted)}
.value{font-size:1.75rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin:.25rem 0}
.change{font-size:.8125rem;color:var(--muted);line-height:1.4;margin-top:.25rem}
.good{color:var(--good)}.bad{color:var(--bad)}
.empty,.note{color:var(--muted);font-size:.9375rem}
.chart{margin:0 0 2rem}
figcaption{font-size:.875rem;font-weight:600;margin-bottom:.75rem}
.plot{position:relative;padding-right:3.75rem}
.plot svg{display:block;width:100%;height:9rem;overflow:visible}
.grid{stroke:var(--line);stroke-width:1}
.line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.y{position:absolute;right:0;transform:translateY(-50%);font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.x{display:flex;justify-content:space-between;padding-right:3.75rem;margin-top:.375rem;font-size:.75rem;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:.875rem}
th{text-align:left;font-weight:500;color:var(--muted);font-size:.8125rem}
th,td{padding:.5rem .75rem .5rem 0;border-bottom:1px solid var(--line);vertical-align:top}
th:last-child,td:last-child{padding-right:0}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.k{overflow-wrap:anywhere}
.rows{list-style:none;margin:0 0 1rem;padding:0;font-size:.9375rem}
.rows li{display:flex;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--line)}
.rows .k{flex:1}
.date{color:var(--muted);white-space:nowrap;min-width:4.5rem;font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1.5rem 2rem}
section.ai{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--soft);padding:1.25rem 1.5rem}
.ai h3{margin:1.5rem 0 .5rem}
.ai ul{margin:0;padding-left:1.25rem}
.ai li{margin:0 0 .375rem}
.preview{border:1px solid var(--bad);padding:.75rem 1rem;margin:0 0 2rem;font-size:.9375rem}
.preview p{margin:0}
footer{border-top:1px solid var(--line);margin-top:3rem;padding-top:1.25rem;color:var(--muted);font-size:.8125rem}
footer p{margin:0 0 .25rem}
@media print{
:root{--bg:#fff;--fg:#000;--muted:#555;--line:#ccc;--soft:#fff;--accent:#2f5bd3;--good:#18794e;--bad:#c4332b;color-scheme:light}
@page{margin:15mm}
body{font-size:11pt}
main{max-width:none;padding:0}
h2,h3,h4{break-after:avoid}
.chart,.stats,tr,li{break-inside:avoid}
}`;

const aiBlock = (ai: AiText) => html`<section class="ai">
<h2>A hónap röviden</h2>
<p>${ai.summary}</p>
${ai.workItems.length > 0 && html`<h3>A hónap munkái</h3><ul>${ai.workItems.map((i) => html`<li>${i}</li>`)}</ul>`}
${ai.suggestions.length > 0 && html`<h3>Javaslatok</h3><ul>${ai.suggestions.map((i) => html`<li>${i}</li>`)}</ul>`}
</section>`;

export function renderReport(client: Client, month: string, sections: [string, Section | null][], opts: RenderOptions): string {
  const period = monthName(month);
  const body = sections.map(([id, s]) => {
    const r = renderers[id];
    if (!r) throw new Error(`Nincs riport-renderer a(z) ${id} forráshoz`);
    return html`<section>
<h2>${r.title}</h2>
${s ? html`${r.lead && html`<p class="lead">${r.lead}</p>`}${r.render(s.data, client)}` : html`<p class="empty">${r.empty}</p>`}
</section>`;
  });
  return html`<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${client.name}: havi riport, ${period}</title>
<style>${raw(CSS)}</style>
</head>
<body>
<main>${opts.preview && html`
<div class="preview" role="note">${opts.preview.map((l) => html`<p>${l}</p>`)}</div>`}
<header>
${opts.brand && html`<p class="brand">${opts.brand}</p>
`}<h1>${client.name}</h1>
<p class="sub">Havi riport, ${period} · ${client.domain}</p>
</header>${opts.ai && html`
${aiBlock(opts.ai)}`}
${body}
<footer>
<p>${opts.brand ? html`Készítette: ${opts.brand}` : "Készült"} · ${longDate(opts.now)}</p>
${opts.ai && html`<p>Az összefoglalót AI segítségével készítettük, emberi jóváhagyással.</p>`}
</footer>
</main>
</body>
</html>
`.__html;
}

const LOCKED: Record<string, string> = { approved: "jóváhagyott", sent: "kiküldött" };

const AI_MISSING: Record<Exclude<AiStatus, "ok">, string> = {
  skipped: "AI-szöveg nincs: a riport --live nélkül készült. AI-szöveggel: cli report <hónap> --client <ügyfél> --live",
  failed: "AI-szöveg nincs: a generálás kétszer is hibás volt, a riport nélküle készült.",
};

// Summarizes every enabled source → outDir/<client>/<month>/index.html (the client version), email.json (the email to send) and preview.html
// (the same with a preview bar, for approval) + reports row (draft, ai_status). AI text only with llm (cli: --live);
// not stored, every run regenerates it. An existing draft can be overwritten; for an approved or sent report it is an error,
// and nothing is written.
export async function generateReport(ctx: Ctx, client: Client, month: string, opts: { now: Date; outDir: string; llm?: Llm }): Promise<string> {
  const status = ctx.db.prepare("SELECT status FROM reports WHERE client_id = ? AND month = ?").pluck().get(client.id, month) as string | undefined;
  if (status && status !== "draft") throw new Error(`${client.id} ${month}: a riport már ${LOCKED[status] ?? status}, nem írható felül`);
  const sections: [string, Section | null][] = [];
  for (const source of registry) {
    if (!client.sources[source.id as keyof Client["sources"]]?.enabled) continue;
    sections.push([source.id, await source.summarize(ctx, client, month)]);
  }
  const ai: AiResult | { status: "skipped" } = opts.llm ? await writeAi(opts.llm, aiInput(client, month, sections)) : { status: "skipped" };
  if (ai.status === "failed") log("warn", "AI-szöveg nem készült", { client: client.id, month, error: ai.error });
  const text = ai.status === "ok" ? ai.text : undefined;
  const preview = [
    "Jóváhagyásra váró előnézet, nem az ügyfélnek küldött változat.",
    ...(ai.status === "ok" ? [] : [AI_MISSING[ai.status]]),
    ...(ai.status === "failed" ? [`Utolsó hiba: ${ai.error}`] : []),
  ];
  // DB guard first: a report approved in the meantime during the long (LLM) generation is not written back to draft and its files are left alone.
  const guard = ctx.db
    .prepare(
      `INSERT INTO reports (client_id, month, status, ai_status) VALUES (?, ?, 'draft', ?)
       ON CONFLICT (client_id, month) DO UPDATE SET ai_status = excluded.ai_status WHERE reports.status = 'draft'`,
    )
    .run(client.id, month, ai.status);
  if (!guard.changes) throw new Error(`${client.id} ${month}: a riport közben jóváhagyásra került, nem írható felül`);
  const dir = join(opts.outDir, client.id, month);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.html");
  const brand = ctx.env.BRAND_NAME;
  writeFileSync(path, renderReport(client, month, sections, { now: opts.now, ai: text, brand }));
  writeFileSync(join(dir, "preview.html"), renderReport(client, month, sections, { now: opts.now, ai: text, preview, brand }));
  // The email comes from the same data and AI text as the page; send sends this, it does not regenerate.
  writeFileSync(join(dir, "email.json"), JSON.stringify(buildEmail(client, month, sections, text, brand)));
  return path;
}
