import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

export type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
export type QueryBody = {
  startDate: string;
  endDate: string;
  dimensions: ("date" | "query" | "page")[];
  rowLimit?: number;
};
// This is the swappable seam in tests: the source calls only this.
export type Query = (property: string, body: QueryBody) => Promise<Row[]>;

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const RETRIES = 5;

type Deps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; token?: () => Promise<string> };

// Sequential calls; exponential backoff on 429 and 5xx (1, 2, 4, 8 s).
// The request asks for dataState: final. startDate/endDate are in the Pacific time zone (see index.ts).
export function createQuery(credentialsPath: string, deps: Deps = {}): Query {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let auth: GoogleAuth | undefined;
  const token =
    deps.token ??
    (async () => {
      auth ??= new GoogleAuth({ keyFile: credentialsPath, scopes: [SCOPE] });
      const t = await auth.getAccessToken();
      if (!t) throw new Error("Nem sikerült hozzáférési tokent kérni a service accounttal");
      return t;
    });

  return async (property, body) => {
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, dataState: "final" }),
      });
      if (res.ok) return ((await res.json()) as { rows?: Row[] }).rows ?? [];
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const msg = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
      if (res.status === 403) {
        // The client_email is not a secret; it is what must be added to the property's users.
        let email = "(a credentials fájlban a client_email)";
        try {
          email = JSON.parse(readFileSync(credentialsPath, "utf8")).client_email ?? email;
        } catch {}
        throw new Error(
          `Nincs jogosultság a Search Console property-hez (${property}). Vedd fel ${email} címet a property felhasználói közé (legalább korlátozott jogosultsággal). ${msg ?? ""}`.trim(),
        );
      }
      throw new Error(`Search Console API hiba: HTTP ${res.status} ${msg ?? ""}`.trim());
    }
  };
}
