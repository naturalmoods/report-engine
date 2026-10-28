import { cloudflare } from "./cloudflare/index.ts";
import { gsc } from "./gsc/index.ts";
import { worklog } from "./worklog/index.ts";
import { uptime } from "./uptime/index.ts";
import type { Source } from "./types.ts";

export const registry: Source[] = [gsc, cloudflare, uptime, worklog];
