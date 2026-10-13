// Email adapter. Only one real implementation: own Postal server's HTTP API (POST <POSTAL_URL>/api/v1/send/message,
// X-Server-API-Key header; source: https://docs.postalserver.io/developer/api and https://apiv1.postalserver.io/controllers/send/message).
export interface Mail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function postalMailer(env: Record<string, string>, fetchFn: typeof fetch = fetch): Mailer {
  const url = new URL("/api/v1/send/message", env.POSTAL_URL);
  return {
    async send(m) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "X-Server-API-Key": env.POSTAL_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, html_body: m.html, plain_body: m.text }),
        signal: AbortSignal.timeout(30_000),
      });
      // Postal can return an error with 200 too: the body's status field decides. Error format not fully verified
      // (the documentation shows error_description, the source code/message): we handle both. The key does not go into the message.
      const body = (await res.json().catch(() => null)) as { status?: string; data?: Record<string, string> } | null;
      if (!res.ok || body?.status !== "success") {
        const why = body?.data?.message ?? body?.data?.error_description ?? body?.data?.code ?? body?.status ?? "ismeretlen válasz";
        throw new Error(`Postal: a küldés sikertelen (HTTP ${res.status}): ${why}`);
      }
    },
  };
}
