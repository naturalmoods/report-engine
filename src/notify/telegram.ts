import { sourceEnv } from "../core/env.ts";
import { log, scrub } from "../core/log.ts";

// Bot API sendMessage: text is 1-4096 characters (https://core.telegram.org/bots/api#sendmessage; not verified with Context7).
// It goes without parse_mode, so plain text: client and error texts need no escaping.
// Safe truncation: we stay under 4000 code points, so UTF-16 counting cannot exceed the limit either.
const MAX = 4000;

export const clip = (text: string, max = MAX): string => {
  const cp = [...text];
  return cp.length <= max ? text : `${cp.slice(0, max - 1).join("")}…`;
};

// Never throws: on missing TELEGRAM_* variables or on error it warns in the log, the command keeps running.
// The token is in the URL; the log and every text go through the scrubber. True if it was sent.
export async function notify(text: string, deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<boolean> {
  try {
    const env = sourceEnv("telegram", deps.env);
    const res = await (deps.fetch ?? fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: scrub(clip(text)), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    log("warn", "telegram-üzenet nem ment el", { reason: (e as Error).message });
    return false;
  }
}
