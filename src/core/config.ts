import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import * as z from "zod";

const enabled = z.boolean().default(true);

const clientSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kisbetű, szám és kötőjel"),
  name: z.string().min(1),
  domain: z.string().min(1),
  package: z.enum(["STABIL", "AKTIV", "PARTNER"]),
  enabled,
  recipients: z.array(z.object({ name: z.string().min(1), email: z.email() })).default([]),
  report: z
    .object({ monthly: z.boolean().default(true), formality: z.enum(["tegezo", "magazo"]) })
    .optional(),
  sources: z
    .object({
      gsc: z.object({ enabled, property: z.string().min(1) }).optional(),
      uptime: z.object({ enabled, urls: z.array(z.url()).min(1) }).optional(),
      worklog: z.object({ enabled, repos: z.array(z.string().min(1)) }).optional(),
      // Web Analytics site tag (dashboard: Web Analytics → the site → its tag); the account comes from env.
      cloudflare: z.object({ enabled, siteTag: z.string().regex(/^[0-9a-f]{32}$/, "32 hexa karakter") }).optional(),
      // Daily PageSpeed Insights (mobile) of these pages (default: https://<domain>/); the API key comes from env.
      pagespeed: z.object({ enabled, urls: z.array(z.url()).min(1).optional() }).optional(),
      // AI crawler access check of one page (default: https://<domain>/); no secret needed.
      aibots: z.object({ enabled, url: z.url().optional() }).optional(),
    })
    .default({}),
});

export type Client = z.infer<typeof clientSchema>;

// One bad file does not stop the rest: per-file errors are returned alongside the valid clients.
export function loadClients(dir: string): { clients: Client[]; errors: { file: string; message: string }[] } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") && f !== "example.yaml").sort();
  const clients: Client[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      errors.push({ file, message: `${file}: érvénytelen YAML: ${(e as Error).message}` });
      continue;
    }
    const r = clientSchema.safeParse(raw);
    if (r.success) clients.push(r.data);
    else errors.push({ file, message: `${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(gyökér)"}: ${i.message}`).join("; ")}` });
  }
  return { clients, errors };
}
