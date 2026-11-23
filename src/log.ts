// Logger that never prints secrets (spec: Storage & secrets, Rules).
// Every line goes through redact(); headers go through redactHeaders() if they are logged at all.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-riot-entitlements-jwt", "location"]);
const secrets = new Set<string>();

/** Register a value that must never appear in a log line, such as the bot token or a cookie value. */
export function addSecret(value: string | undefined | null): void {
  // Very short values would redact ordinary words; real secrets are long.
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out
    .replace(/ssid=[^;\s"]*/gi, "ssid=[redacted]")
    .replace(/Bearer\s+[^\s",}]+/gi, "Bearer [redacted]")
    .replace(/eyJ[\w-]*(?:\.[\w-]*){0,2}/g, "[jwt]");
}

export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v]));
}

function minLevel(): number {
  const wanted = process.env.LOG_LEVEL as Level | undefined;
  return (wanted && LEVELS[wanted]) || LEVELS.info;
}

// Errors stringify to {} by default; keep their name and message.
const errorReplacer = (_key: string, value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message } : value;

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel()) return;
  // sv-SE formats as "2026-11-23 10:15:00" in the local time zone (TZ).
  const time = new Date().toLocaleString("sv-SE", { hour12: false });
  const extra = fields ? ` ${JSON.stringify(fields, errorReplacer)}` : "";
  const line = redact(`${time} ${level.toUpperCase().padEnd(5)} ${message}${extra}`);
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
