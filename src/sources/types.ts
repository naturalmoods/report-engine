import type { Client } from "../core/config.ts";
import type { Db } from "../core/db.ts";

export type { Client };

export interface Ctx {
  db: Db;
  env: Record<string, string>;
  dryRun?: boolean;
}

// Serializable data (numbers, series, lists); rendering is the job of src/report/.
export type Section = { source: string; data: Record<string, unknown> };

export interface Source {
  id: string;
  // The default day for collect (without --day); the lag differs per source.
  defaultDay(): string;
  collect(ctx: Ctx, client: Client, day: string): Promise<void>;
  collectMonthly?(ctx: Ctx, client: Client, month: string): Promise<void>;
  backfill?(ctx: Ctx, client: Client, from: string): Promise<void>;
  summarize(ctx: Ctx, client: Client, month: string): Promise<Section | null>;
}
