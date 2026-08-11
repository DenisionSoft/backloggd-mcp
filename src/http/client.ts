import { request } from "undici";
import { CookieJar } from "tough-cookie";
import { BASE_URL, USER_AGENT, redact, type Config } from "../config.js";
import { AuthError, HttpError, RateLimitError } from "../errors.js";
import { RateLimiter } from "./ratelimit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Form-encoded body. Values are stringified and `undefined` entries dropped.
   *
   * An array value is emitted as a repeated key, which is what Rails expects for a
   * `ids[]`-style parameter. Indexed keys (`ids[0]`) would arrive as a hash instead of
   * an array and the controller 500s, so arrays must go through this path.
   */
  form?: Record<string, string | number | boolean | undefined | string[]>;
  query?: Record<string, string | number | undefined>;
  /**
   * JSON body. Some endpoints (list entry reordering) accept either form-encoding or
   * JSON, and JSON is the only sane way to send a nested array of entries.
   */
  json?: unknown;
  headers?: Record<string, string>;
  /** Ask for a Turbo Stream response instead of a full page. */
  turboStream?: boolean;
  /**
   * Marks the request as mutating. Write requests get the stricter throttle, a CSRF
   * header, and are refused outright in read-only mode.
   */
  write?: boolean;
  /** Skip the CSRF header even on a non-GET (used by the login POST itself). */
  noCsrf?: boolean;
}

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  url: string;
}

/**
 * Everything that talks to Backloggd goes through here, so that throttling, retries,
 * cookies and CSRF exist in exactly one place.
 */
export class HttpClient {
  private readonly jar = new CookieJar();
  private readonly limiter: RateLimiter;

  /** Rails CSRF token, cached for the session and refreshed on a 422. */
  private csrfToken: string | null = null;

  /** Set by SessionManager so the client can re-authenticate after an expiry. */
  private reauthenticate: (() => Promise<void>) | null = null;
  private reauthInFlight: Promise<void> | null = null;

  constructor(private readonly config: Config) {
    this.limiter = new RateLimiter(config);
  }

  onSessionExpired(fn: () => Promise<void>): void {
    this.reauthenticate = fn;
  }

  rateLimitStatus() {
    return this.limiter.status();
  }

  async setSessionCookie(value: string): Promise<void> {
    const clean = value.trim().replace(/^_backloggd_session=/, "");
    await this.jar.setCookie(
      `_backloggd_session=${clean}; Domain=backloggd.com; Path=/; Secure; HttpOnly`,
      BASE_URL,
    );
    // Suppresses the consent interstitial some pages render for fresh visitors.
    await this.jar.setCookie(
      `ne_cookies_consent=true; Domain=backloggd.com; Path=/`,
      BASE_URL,
    );
  }

  async getSessionCookie(): Promise<string | null> {
    const cookies = await this.jar.getCookies(BASE_URL);
    return cookies.find((c) => c.key === "_backloggd_session")?.value ?? null;
  }

  async clearCsrf(): Promise<void> {
    this.csrfToken = null;
  }

  /**
   * Fetch (and cache) the Rails CSRF token. Any page carries it in a meta tag, and one
   * token is valid for the whole session.
   */
  async getCsrfToken(force = false): Promise<string> {
    if (this.csrfToken && !force) return this.csrfToken;
    const res = await this.raw("/", { method: "GET" });
    const token = extractCsrf(res.body);
    if (!token) {
      throw new AuthError(
        "Could not find a CSRF token on the Backloggd homepage.",
        "Backloggd's markup may have changed, or the request was intercepted.",
      );
    }
    this.csrfToken = token;
    return token;
  }

  /** Public entry point: throttled, retried, CSRF-aware, re-auth-aware. */
  async fetch(path: string, opts: RequestOptions = {}): Promise<Response> {
    const isWrite = opts.write === true;
    return this.limiter.schedule(() => this.withRetries(path, opts), isWrite);
  }

  private async withRetries(path: string, opts: RequestOptions): Promise<Response> {
    const method = opts.method ?? "GET";
    const needsCsrf = method !== "GET" && !opts.noCsrf;
    let csrfRetried = false;
    let authRetried = false;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const headers = { ...(opts.headers ?? {}) };
        if (needsCsrf) headers["X-CSRF-Token"] = await this.getCsrfToken();

        const res = await this.raw(path, { ...opts, headers });

        if (res.status === 429) {
          const retryAfter = headerValue(res.headers, "retry-after");
          const waitMs = this.limiter.note429(retryAfter, attempt);
          if (attempt >= this.config.maxRetries) {
            throw new RateLimitError(
              `Backloggd rate limited this request (429) after ${attempt + 1} attempts.`,
              waitMs,
            );
          }
          await sleep(waitMs);
          continue;
        }

        // Rails answers a bad/stale CSRF token with 422. Refresh once, then give up:
        // retrying a token failure in a loop is how you look like an attacker.
        if (res.status === 422 && needsCsrf && !csrfRetried) {
          csrfRetried = true;
          await this.getCsrfToken(true);
          continue;
        }

        if (this.looksLoggedOut(res) && !authRetried && this.reauthenticate) {
          authRetried = true;
          await this.doReauth();
          continue;
        }

        this.limiter.noteSuccess();

        if (res.status >= 400) {
          throw new HttpError(res.status, path, res.body.slice(0, 500));
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt >= this.config.maxRetries) throw err;

        // The user's network path to Backloggd stalls intermittently — connections open
        // and then deliver nothing. Treat that as transient and retry with backoff
        // rather than reporting the endpoint as broken.
        const backoff = Math.min(1000 * 2 ** attempt, 15_000) + Math.random() * 500;
        this.debug(`retry ${attempt + 1}/${this.config.maxRetries} for ${path}: ${describe(err)}`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  /** Collapse concurrent re-auth attempts into one. */
  private async doReauth(): Promise<void> {
    if (!this.reauthenticate) return;
    if (!this.reauthInFlight) {
      this.reauthInFlight = this.reauthenticate().finally(() => {
        this.reauthInFlight = null;
      });
    }
    await this.reauthInFlight;
  }

  /**
   * A single HTTP round trip. No retries, no throttling — callers use `fetch`.
   * `bodyTimeout` is the stall detector: it fires when the connection is open but no
   * bytes arrive, which is this network's characteristic failure.
   */
  private async raw(path: string, opts: RequestOptions): Promise<Response> {
    const url = new URL(path.startsWith("http") ? path : BASE_URL + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: opts.turboStream
        ? "text/vnd.turbo-stream.html, text/html, application/json"
        : "text/html,application/json,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Referer: BASE_URL + "/",
      Origin: BASE_URL,
      ...(opts.headers ?? {}),
    };

    const cookie = await this.jar.getCookieString(url.toString());
    if (cookie) headers["Cookie"] = cookie;

    let body: string | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["Content-Type"] = "application/json";
    } else if (opts.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) params.append(k, item);
        else params.append(k, String(v));
      }
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }

    this.debug(`${opts.method ?? "GET"} ${url.pathname}${url.search}`);

    const res = await request(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body,
      headersTimeout: Math.min(this.config.requestTimeoutMs, 25_000),
      bodyTimeout: Math.min(this.config.requestTimeoutMs, 25_000),
    });

    const setCookie = res.headers["set-cookie"];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const c of list) {
        await this.jar.setCookie(c, url.toString()).catch(() => undefined);
      }
    }

    const text = await res.body.text();

    // Follow same-host redirects ourselves so the cookie jar stays authoritative.
    const location = headerValue(res.headers, "location");
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      const next = new URL(location, url);
      if (next.host === url.host && !isLoginPath(next.pathname)) {
        return this.raw(next.pathname + next.search, { ...opts, method: "GET", form: undefined });
      }
    }

    return {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: text,
      url: url.toString(),
    };
  }

  /** Rails bounces unauthenticated requests to the login page. */
  private looksLoggedOut(res: Response): boolean {
    const location = headerValue(res.headers, "location");
    if (res.status >= 300 && res.status < 400 && location && isLoginPath(location)) return true;
    if (res.status === 401) return true;
    return (
      res.status === 200 &&
      res.body.includes('action="/users/sign_in"') &&
      !res.body.includes("/users/sign_out")
    );
  }

  private debug(msg: string): void {
    if (this.config.debug) process.stderr.write(`[backloggd-mcp] ${redact(msg)}\n`);
  }
}

export function extractCsrf(html: string): string | null {
  return /<meta name="csrf-token" content="([^"]+)"/.exec(html)?.[1] ?? null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function isLoginPath(p: string): boolean {
  return p.includes("/users/sign_in") || p.includes("/login");
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return false;
  if (err instanceof AuthError) return false;
  if (err instanceof HttpError) {
    // 403 shows up sporadically from the CDN on paths that work seconds later.
    return err.status === 403 || err.status >= 500;
  }
  const code = (err as { code?: string } | undefined)?.code;
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
