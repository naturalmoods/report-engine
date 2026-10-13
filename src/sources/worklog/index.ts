import { randomUUID } from "node:crypto";
import { addDays, addMonths, budapestDay, today } from "../../core/dates.ts";
import type { Db } from "../../core/db.ts";
import { sourceEnv } from "../../core/env.ts";
import type { Client, Ctx, Section, Source } from "../types.ts";

const SOURCE = "worklog";
const PER_PAGE = 100;
const BOT_NAME = /^(dependabot|renovate|github-actions)/i;

export interface Deps {
  fetch?: typeof fetch;
  token?: () => string;
}

type GhCommit = {
  sha: string;
  html_url: string;
  parents: unknown[];
  author: { login: string } | null;
  committer: { login: string } | null;
  commit: { message: string; author: { name: string; date: string }; committer: { name: string; date: string } };
};

// merge: multiple parents; bot: login ending in [bot] or a known bot name; otherwise commit. merge outranks bot
// (the merge commit of a dependabot PR merged by a human is work, not bot noise).
export function classify(c: GhCommit): "commit" | "merge" | "bot" {
  if (c.parents.length > 1) return "merge";
  const names = [c.author?.login, c.committer?.login, c.commit.author.name];
  if (names.some((n) => n && (n.endsWith("[bot]") || BOT_NAME.test(n)))) return "bot";
  return "commit";
}

function failure(repo: string, status: number, headers: Headers): Error {
  if (status === 401) return new Error(`${repo}: a GitHub elutasította a tokent (401), valószínűleg lejárt vagy hibás`);
  if (status === 403 && headers.get("x-ratelimit-remaining") === "0")
    return new Error(`${repo}: GitHub rate limit elfogyott (403), később újra próbálható`);
  if (status === 403 || status === 404)
    return new Error(`${repo}: nem érhető el (${status}), valószínűleg a token nem fér hozzá a repóhoz (vagy a repó nem létezik)`);
  return new Error(`${repo}: váratlan GitHub-válasz (${status})`);
}

// Download all pages (Link: rel="next"), commits of the default branch (sha parameter omitted = default branch).
async function fetchCommits(f: typeof fetch, token: string, repo: string, since: string): Promise<GhCommit[]> {
  const out: GhCommit[] = [];
  let url: string | undefined = `https://api.github.com/repos/${repo}/commits?per_page=${PER_PAGE}&since=${since}`;
  while (url) {
    const res: Response = await f(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "report-engine" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 409) return out; // empty repo
    if (!res.ok) throw failure(repo, res.status, res.headers);
    out.push(...((await res.json()) as GhCommit[]));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
  }
  return out;
}

const stateKey = (repo: string) => `cursor:${repo}`;
const INSERT = `INSERT OR IGNORE INTO events (client_id, source, external_id, type, ts, title, meta_json) VALUES (?, 'worklog', ?, ?, ?, ?, ?)`;
const SET_STATE = `INSERT INTO source_state (client_id, source, key, value) VALUES (?, 'worklog', ?, ?)
  ON CONFLICT (client_id, source, key) DO UPDATE SET value = excluded.value`;

export function addManual(db: Db, clientId: string, text: string, date: string, minutes?: number): void {
  // Noon UTC: the same day in Budapest (with DST too).
  db.prepare(INSERT).run(clientId, `manual:${randomUUID()}`, "manual", `${date}T12:00:00.000Z`, text, JSON.stringify({ minutes: minutes ?? null }));
}

export function makeSource(deps: Deps = {}): Source {
  const f = deps.fetch ?? fetch;
  const getToken = deps.token ?? (() => sourceEnv("worklog").GITHUB_TOKEN);

  // since = null: from the repo's cursor (lacking that, 16 months back); otherwise a fixed start, the cursor is ignored.
  // One repo failing does not stop the rest; the error is thrown collected at the end, so the run is "error" but the other repos are saved.
  async function sync(ctx: Ctx, client: Client, since: string | null) {
    const token = ctx.dryRun ? "" : getToken();
    const errors: string[] = [];
    for (const repo of client.sources.worklog!.repos) {
      try {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${repo}: érvénytelen repónév (owner/name kell)`);
        const key = stateKey(repo);
        const cursor = ctx.db.prepare("SELECT value FROM source_state WHERE client_id = ? AND source = 'worklog' AND key = ?").pluck().get(client.id, key) as string | undefined;
        const from = since ?? cursor ?? `${addMonths(today().slice(0, 7), -15)}-01T00:00:00Z`;
        if (ctx.dryRun) {
          console.log(`${client.id} worklog ${repo} commitjai ${from} óta`);
          continue;
        }
        const commits = await fetchCommits(f, token, repo, from);
        // Cursor = the largest committer date (the GitHub `since` filter uses it). Advances only after full pagination,
        // in the same transaction as saving the events, so an interrupted pagination does not skip a commit.
        const max = commits.reduce((m, c) => (c.commit.committer.date > m ? c.commit.committer.date : m), cursor ?? "");
        ctx.db.transaction(() => {
          for (const c of commits) {
            // ts = author date (when the developer worked; the committer date changes on rebase).
            ctx.db.prepare(INSERT).run(
              client.id,
              `${repo.toLowerCase()}@${c.sha}`,
              classify(c),
              new Date(c.commit.author.date).toISOString(),
              c.commit.message.split("\n")[0],
              JSON.stringify({ repo, sha: c.sha, url: c.html_url, author: c.commit.author.name }),
            );
          }
          if (max && max !== cursor) ctx.db.prepare(SET_STATE).run(client.id, key, max);
        })();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
  }

  return {
    id: SOURCE,
    defaultDay: () => today(), // collection is cursor-based, the day does not matter
    collect: (ctx, client) => sync(ctx, client, null),
    // from: YYYY-MM; backfills from the start of the month (UTC), only moves the cursor forward.
    backfill: (ctx, client, from) => sync(ctx, client, `${from}-01T00:00:00Z`),

    // Raw events grouped by type; the month is by Europe/Budapest.
    async summarize(ctx, client, month) {
      const rows = (ctx.db
        .prepare("SELECT type, ts, title, meta_json FROM events WHERE client_id = ? AND source = 'worklog' AND ts >= ? AND ts < ? ORDER BY ts")
        .all(client.id, `${addDays(`${month}-01`, -1)}T00:00:00Z`, `${addMonths(month, 1)}-02T00:00:00Z`) as { type: string; ts: string; title: string; meta_json: string }[])
        .filter((e) => budapestDay(e.ts).startsWith(month));
      if (!rows.length) return null;
      const events: Record<string, unknown[]> = {};
      const counts: Record<string, number> = {};
      let manualMinutes = 0;
      for (const r of rows) {
        const meta = JSON.parse(r.meta_json);
        (events[r.type] ??= []).push({ date: budapestDay(r.ts), title: r.title, ...meta });
        counts[r.type] = (counts[r.type] ?? 0) + 1;
        if (r.type === "manual") manualMinutes += meta.minutes ?? 0;
      }
      const data: Section["data"] = { month, counts, manualMinutes, events };
      return { source: SOURCE, data };
    },
  };
}

export const worklog = makeSource();
