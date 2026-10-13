// One-line JSON log to stdout. Scrubs secret values: the value of every env variable whose name
// ends with or contains KEY/TOKEN/SECRET/PASSWORD.
let command: string | undefined;

export function setCommand(name: string): void {
  command = name;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|HEALTHCHECK_URL/;

export function scrub(line: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && SECRET_NAME.test(name)) line = line.replaceAll(value, "[titok]");
  }
  return line;
}

export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: { client?: string; source?: string; [k: string]: unknown } = {},
): void {
  console.log(scrub(JSON.stringify({ level, time: new Date().toISOString(), command, ...fields, msg })));
}
