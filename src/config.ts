import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "https://backloggd.com";

/**
 * Honest, identifiable User-Agent. We do not impersonate a browser.
 *
 * Backloggd's robots.txt is aimed at crawlers and AI training scrapers; this tool is
 * neither. It acts only as the signed-in user, on that user's own data, doing things
 * they could do by hand in their browser. Saying so plainly — rather than hiding behind
 * a fake Chrome string — is the whole point, and it means the operator can identify and
 * contact us if they ever object.
 */
export const USER_AGENT =
  `backloggd-mcp/${process.env["npm_package_version"] ?? "0.1.0"} ` +
  `(+https://github.com/DenisionSoft/backloggd-mcp; user-driven MCP client, not a crawler)`;

export type AuthMode = "session" | "password" | "browser" | "none";

export interface Config {
  authMode: AuthMode;
  session?: string;
  username?: string;
  password?: string;
  browser?: "firefox" | "chrome";
  readOnly: boolean;
  statePath: string;
  /** Floor on the gap between any two requests, ms. */
  minRequestIntervalMs: number;
  /** Floor on the gap between two writes, ms. Deliberately much larger. */
  minWriteIntervalMs: number;
  maxWritesPerMinute: number;
  maxWritesPerHour: number;
  requestTimeoutMs: number;
  maxRetries: number;
  /**
   * Soft wall-clock budget for a single batch tool call, ms. On reaching it a tool
   * returns what it has plus the names it did not get to, instead of running past the
   * MCP client's tool-call timeout and losing the whole result.
   */
  batchBudgetMs: number;
  /** Emit request-level diagnostics on stderr. Never includes credentials. */
  debug: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function loadConfig(): Config {
  const session = process.env["BACKLOGGD_SESSION"]?.trim() || undefined;
  const username = process.env["BACKLOGGD_USERNAME"]?.trim() || undefined;
  const password = process.env["BACKLOGGD_PASSWORD"] || undefined;
  const browserRaw = process.env["BACKLOGGD_BROWSER_IMPORT"]?.trim().toLowerCase();
  const browser =
    browserRaw === "firefox" || browserRaw === "chrome" ? browserRaw : undefined;

  // Resolution order matches the documented precedence in the README.
  let authMode: AuthMode = "none";
  if (session) authMode = "session";
  else if (username && password) authMode = "password";
  else if (browser) authMode = "browser";

  return {
    authMode,
    session,
    username,
    password,
    browser,
    readOnly: envBool("BACKLOGGD_READONLY"),
    statePath:
      process.env["BACKLOGGD_STATE_PATH"]?.trim() ||
      join(homedir(), ".backloggd-mcp", "session.json"),

    // Reads run at ~3/second. That is still far below what a person clicking around
    // generates in bursts, and it keeps batch tools inside a client's tool-call
    // timeout — a limit that used to make a 40-game check fail outright rather than
    // merely run slowly. Writes stay deliberately slow: they are the ones that trip
    // Backloggd's own per-action limits, and a restricted account is a much worse
    // outcome than a slow tool.
    minRequestIntervalMs: envInt("BACKLOGGD_MIN_REQUEST_INTERVAL_MS", 350),
    minWriteIntervalMs: envInt("BACKLOGGD_MIN_WRITE_INTERVAL_MS", 2500),
    maxWritesPerMinute: envInt("BACKLOGGD_MAX_WRITES_PER_MINUTE", 12),
    maxWritesPerHour: envInt("BACKLOGGD_MAX_WRITES_PER_HOUR", 200),

    requestTimeoutMs: envInt("BACKLOGGD_REQUEST_TIMEOUT_MS", 45_000),
    // Deliberately well under a typical MCP client tool-call timeout (~60s). The
    // budget is checked between requests, so a single slow request can overshoot it —
    // leaving headroom is what keeps the overshoot from becoming a lost result.
    batchBudgetMs: envInt("BACKLOGGD_BATCH_BUDGET_MS", 25_000),
    maxRetries: envInt("BACKLOGGD_MAX_RETRIES", 5),
    debug: envBool("BACKLOGGD_DEBUG"),
  };
}

/** Redact anything that looks like a credential before it reaches a log line. */
export function redact(text: string): string {
  return text
    .replace(/(_backloggd_session=)[^;\s]+/gi, "$1<redacted>")
    .replace(/(X-CSRF-Token:\s*)\S+/gi, "$1<redacted>")
    .replace(/(authenticity_token[=:"\s]+)[\w\-+/=]+/gi, "$1<redacted>")
    .replace(/(password[=:"\s]+)[^&\s"]+/gi, "$1<redacted>");
}
