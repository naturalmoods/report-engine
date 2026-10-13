// HTML building with a tagged template: every inserted value is escaped, except the result of html`` / raw().
export type Html = { readonly __html: string };
type Val = Html | string | number | null | undefined | false | Val[];

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c]);
export const raw = (s: string): Html => ({ __html: s });

const part = (v: Val): string =>
  v == null || v === false ? "" : Array.isArray(v) ? v.map(part).join("") : typeof v === "object" ? v.__html : esc(String(v));

export function html(strings: TemplateStringsArray, ...vals: Val[]): Html {
  let out = strings[0];
  vals.forEach((v, i) => (out += part(v) + strings[i + 1]));
  return raw(out);
}

// hu-HU number format. The negative sign is a real minus sign (U+2212) everywhere, not a hyphen.
const minus = (s: string) => s.replace("-", "−");
const nf = (digits: number, fixed: boolean, sign: boolean) =>
  new Intl.NumberFormat("hu-HU", {
    maximumFractionDigits: digits,
    minimumFractionDigits: fixed ? digits : 0,
    signDisplay: sign ? "exceptZero" : "auto",
  });
export const num = (v: number, digits = 0) => minus(nf(digits, false, false).format(v));
// Change with sign, fixed decimals: +12,3 / −4,0 / 0,0
export const signed = (v: number, digits = 1) => minus(nf(digits, true, true).format(v));
export const pctChange = (ratio: number) => `${signed(ratio * 100)}%`;

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("hu-HU", opts);
// YYYY-MM and YYYY-MM-DD values are calendar dates: formatted in UTC they do not shift.
export const monthName = (month: string) => fmt({ year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-15T00:00:00Z`));
export const shortDay = (day: string) => fmt({ month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
export const longDate = (d: Date) => fmt({ dateStyle: "long", timeZone: "Europe/Budapest" }).format(d);
export const dateTime = (ts: string) =>
  fmt({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Budapest" }).format(new Date(ts));

export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  const parts = [[Math.floor(m / 1440), "nap"], [Math.floor((m % 1440) / 60), "óra"], [m % 60, "perc"]] as const;
  return parts.filter(([n]) => n).map(([n, u]) => `${n} ${u}`).join(" ") || "1 percnél rövidebb";
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].find((m) => m * p >= v)! * p;
}

// Daily line chart. values[i] = the (i+1)th day of the month, null = no data (the line breaks).
// The drawing area stretches to any width with preserveAspectRatio="none"; the labels are in HTML,
// so they do not shrink to unreadable on mobile either. Colors from CSS variables (dark mode).
export function lineChart(title: string, values: (number | null)[], from: string, to: string, unit = ""): Html {
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) return html`<p class="empty">${title}: a grafikonhoz nincs elég napi adat.</p>`;
  const max = niceMax(Math.max(...known));
  const W = 1000, H = 100;
  const x = (i: number) => +((i / (values.length - 1)) * W).toFixed(1);
  const y = (v: number) => +(H - (v / max) * H).toFixed(1);
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i)} ${y(v)}`;
    pen = true;
  });
  const label = `${title}, ${from} – ${to}: legkisebb ${num(Math.min(...known))}${unit}, legnagyobb ${num(Math.max(...known))}${unit}`;
  return html`<figure class="chart">
<figcaption>${title}</figcaption>
<div class="plot">
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}"><title>${label}</title>
${[0, H / 2, H].map((g) => html`<line class="grid" x1="0" x2="${W}" y1="${g}" y2="${g}" vector-effect="non-scaling-stroke"/>`)}
<path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
</svg>
<span class="y" style="top:0">${num(max)}${unit}</span><span class="y" style="top:50%">${num(max / 2)}${unit}</span><span class="y" style="top:100%">0</span>
</div>
<div class="x"><span>${from}</span><span>${to}</span></div>
</figure>`;
}
