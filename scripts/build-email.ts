// Developer step: compile the email template MJML → HTML (npm run build:email). The output is committed,
// so the production image has no mjml; tests/email.test.ts checks that the output is in sync with the source.
import { readFileSync, writeFileSync } from "node:fs";
import mjml2html from "mjml";

const dir = new URL("../src/report/templates/email/", import.meta.url);

export async function compile(): Promise<string> {
  const { html, errors } = await mjml2html(readFileSync(new URL("email.mjml", dir), "utf8"), { validationLevel: "strict" });
  if (errors.length) throw new Error(`MJML-figyelmeztetés: ${errors.map((e) => e.formattedMessage).join("; ")}`);
  return html;
}

if (import.meta.main) writeFileSync(new URL("email.html", dir), await compile());
