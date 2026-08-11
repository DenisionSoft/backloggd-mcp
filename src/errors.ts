/** Error types that carry enough context for a tool handler to explain itself. */

export class BackloggdError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "BackloggdError";
  }
}

/** No usable session, or the session went stale and could not be renewed. */
export class AuthError extends BackloggdError {
  constructor(message: string, hint?: string) {
    super(message, "AUTH", hint);
    this.name = "AuthError";
  }
}

/** Backloggd asked us to slow down. */
export class RateLimitError extends BackloggdError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(
      message,
      "RATE_LIMIT",
      "Backloggd is rate limiting this account. Wait before retrying — repeatedly " +
        "hammering a 429 is what gets accounts restricted.",
    );
    this.name = "RateLimitError";
  }
}

/**
 * The client's own circuit breaker tripped. This is deliberately not the same as
 * RateLimitError: it means we decided to stop, before Backloggd had to tell us to.
 */
export class CircuitOpenError extends BackloggdError {
  constructor(readonly resumesAt: number) {
    super(
      `Too many rate-limit responses in a row. Local circuit breaker is open until ` +
        `${new Date(resumesAt).toISOString()} to protect the account from restriction.`,
      "CIRCUIT_OPEN",
      "This is a safety stop, not a Backloggd error. Wait for the cooldown.",
    );
    this.name = "CircuitOpenError";
  }
}

/** Non-2xx that isn't auth or rate limiting. */
export class HttpError extends BackloggdError {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(`HTTP ${status} for ${url}`, "HTTP", undefined);
    this.name = "HttpError";
  }
}

/** A page parsed, but not into the shape we expected — almost always a site redesign. */
export class ParseError extends BackloggdError {
  constructor(what: string, url?: string) {
    super(
      `Could not parse ${what}${url ? ` from ${url}` : ""}.`,
      "PARSE",
      "Backloggd's markup has probably changed. Run `backloggd-mcp --selftest` to see " +
        "which parsers are affected.",
    );
    this.name = "ParseError";
  }
}

/** A write was attempted while the server is in read-only mode. */
export class ReadOnlyError extends BackloggdError {
  constructor(tool: string) {
    super(
      `'${tool}' modifies your Backloggd account, and this server is running in read-only mode.`,
      "READ_ONLY",
      "Unset BACKLOGGD_READONLY to enable write tools.",
    );
    this.name = "ReadOnlyError";
  }
}

/** A destructive action was attempted without a valid confirmation token. */
export class ConfirmationRequiredError extends BackloggdError {
  constructor(
    message: string,
    readonly preview: unknown,
    readonly confirmationToken: string,
  ) {
    super(message, "CONFIRMATION_REQUIRED");
    this.name = "ConfirmationRequiredError";
  }
}
