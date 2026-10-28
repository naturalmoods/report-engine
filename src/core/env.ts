import * as z from "zod";

const str = z.string().min(1);

// Variable groups; a command requests only its own groups.
const groups = {
  base: z.object({
    DATABASE_PATH: str.default("./data/report-engine.db"),
    CONFIG_DIR: str.default("./config/clients"),
    OUT_DIR: str.default("./out"),
    // Agency name shown in the report and email header/footer; without it no name is shown.
    BRAND_NAME: str.optional(),
    // External dead-man ping at the end of the uptime round; without it there is no ping. Counts as a secret (the token is in the URL).
    HEALTHCHECK_URL: z.url().optional(),
  }),
  gsc: z.object({ GOOGLE_APPLICATION_CREDENTIALS: str }),
  worklog: z.object({ GITHUB_TOKEN: str }),
  cloudflare: z.object({ CLOUDFLARE_API_TOKEN: str, CLOUDFLARE_ACCOUNT_ID: str }),
  ai: z.object({ ANTHROPIC_API_KEY: str, LLM_MODEL: str }),
  // Own Postal server: POSTAL_URL is the server base URL (e.g. https://postal.example.hu), POSTAL_API_KEY is a "server" type API key.
  email: z.object({ POSTAL_URL: z.url(), POSTAL_API_KEY: str, EMAIL_FROM: str }),
  previewTo: z.object({ EMAIL_PREVIEW_TO: str }),
  r2: z.object({ R2_ACCOUNT_ID: str, R2_ACCESS_KEY_ID: str, R2_SECRET_ACCESS_KEY: str }),
  reports: z.object({ R2_BUCKET_REPORTS: str, REPORT_BASE_URL: z.url() }),
  backups: z.object({ R2_BUCKET_BACKUPS: str }),
  telegram: z.object({ TELEGRAM_BOT_TOKEN: str, TELEGRAM_CHAT_ID: str }),
};

type Group = keyof typeof groups;

// The groups each command actually uses (base is always required). The source variables (gsc, worklog)
// are requested not by the command but by the source in its own run (sourceEnv), so a missing secret fails only that run.
const byCommand: Record<string, Group[]> = {
  collect: [],
  "collect-monthly": [],
  uptime: [],
  backfill: [],
  log: [],
  // The AI variables are requested only by --live (sourceEnv("ai")), delivery (8.) requests its own at the point of use; the report also runs without them.
  report: [],
  approve: [],
  send: ["email", "r2", "reports"],
  // The preview send after report; the cli skips it on a missing variable (with a warning), it does not fail.
  preview: ["email", "previewTo", "r2", "reports"],
  status: [],
  backup: ["r2", "backups"],
  // Only DATABASE_PATH is needed.
  restore: [],
};

function read(wanted: Group[], source: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const g of wanted) {
    const r = groups[g].safeParse(source);
    if (r.success) Object.assign(env, r.data);
    // Only the variable name goes into the message, never its value.
    else missing.push(...r.error.issues.map((i) => String(i.path[0])));
  }
  if (missing.length) throw new Error(`Hiányzó vagy hibás env-változó: ${missing.join(", ")}`);
  return env as z.infer<typeof groups.base> & Record<string, string>;
}

export const loadEnv = (command: string, source: NodeJS.ProcessEnv = process.env) =>
  read(["base", ...(byCommand[command] ?? [])], source);

// A source calls it in its own withRun (on a missing variable only that run fails); the "ai" group is used by report --live.
export const sourceEnv = (group: "gsc" | "worklog" | "cloudflare" | "ai" | "telegram", source: NodeJS.ProcessEnv = process.env) => read([group], source);
