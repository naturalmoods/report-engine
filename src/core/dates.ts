// Today in Budapest (not the container TZ): Intl, sv-SE = YYYY-MM-DD.
export function today(now = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
}

// The previous calendar month as YYYY-MM, Budapest time (cron cannot compute months).
export function previousMonth(now = new Date()): string {
  return addMonths(today(now).slice(0, 7), -1);
}

// Works on YYYY-MM-DD / YYYY-MM values stored as text (in UTC), so the container time zone does not matter.
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

export const lastDayOf = (month: string): string => addDays(`${addMonths(month, 1)}-01`, -1);

// The "day"/"month" boundary is Europe/Budapest local time (not the container TZ, not UTC); computed from UTC ISO timestamps, correct across DST too.
export const budapestDay = (ts: string): string => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });

// Budapest local midnight (start of the day) as a UTC ISO timestamp.
export function budapestMidnight(day: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const wall = Date.parse(`${new Date(guess).toLocaleString("sv-SE", { timeZone: "Europe/Budapest" }).replace(" ", "T")}Z`);
  return new Date(guess - (wall - guess)).toISOString();
}
