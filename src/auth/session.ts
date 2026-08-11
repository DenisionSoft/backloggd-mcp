import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import { AuthError, HttpError } from "../errors.js";
import { extractCsrf, type HttpClient } from "../http/client.js";
import { importSessionFromBrowser } from "./browser-import.js";

export interface Identity {
  username: string;
  /** Numeric account id, required by the full log-write endpoint. */
  userId: string;
}

/**
 * Identifies the configured credentials without storing them.
 *
 * Hashed, so the state file never holds a password or a second copy of the session
 * cookie. Distinct credentials must produce distinct fingerprints — that is what stops
 * a cached session from being reused after the configuration changed.
 */
export function credentialFingerprint(config: Config): string {
  const material =
    config.authMode === "session"
      ? `session:${config.session ?? ""}`
      : config.authMode === "password"
        ? `password:${config.username ?? ""}:${config.password ?? ""}`
        : config.authMode === "browser"
          ? `browser:${config.browser ?? ""}`
          : "none";
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

interface PersistedState {
  session: string;
  identity?: Identity;
  savedAt: number;
  /**
   * Fingerprint of the credentials this session was obtained with. The cache is only
   * reused when it still matches, so changing BACKLOGGD_SESSION or switching accounts
   * cannot silently keep you signed in as the previous one.
   */
  credentialFingerprint?: string;
}

/**
 * Owns "who are we and are we still logged in".
 *
 * Backloggd needs three separate pieces of state for a write: the session cookie, a
 * CSRF token (held by HttpClient), and the numeric user id — which, awkwardly, is not
 * on the profile page and has to be scraped from /settings/.
 */
export class SessionManager {
  private identity: Identity | null = null;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
  ) {
    this.http.onSessionExpired(async () => {
      this.identity = null;
      await this.http.clearCsrf();
      await this.establish(true);
    });
  }

  /** Idempotent: safe to call from every tool handler. */
  async ensureAuthenticated(): Promise<Identity> {
    if (!this.ready) this.ready = this.establish(false);
    await this.ready;
    if (!this.identity) {
      throw new AuthError(
        "Not authenticated with Backloggd.",
        authHint(this.config),
      );
    }
    return this.identity;
  }

  getIdentity(): Identity | null {
    return this.identity;
  }

  private async establish(forceFresh: boolean): Promise<void> {
    if (this.config.authMode === "none") {
      throw new AuthError("No Backloggd credentials configured.", authHint(this.config));
    }

    if (!forceFresh && (await this.tryPersistedSession())) return;

    switch (this.config.authMode) {
      case "session": {
        if (!this.config.session) throw new AuthError("BACKLOGGD_SESSION is empty.");
        await this.http.setSessionCookie(this.config.session);
        this.identity = await this.probeIdentity();
        if (!this.identity) {
          throw new AuthError(
            "The supplied BACKLOGGD_SESSION cookie is not valid (or has expired).",
            "Copy a fresh _backloggd_session value from your browser, or switch to " +
              "BACKLOGGD_USERNAME/BACKLOGGD_PASSWORD so the server can renew it itself.",
          );
        }
        break;
      }
      case "browser": {
        const cookie = await importSessionFromBrowser(this.config.browser ?? "firefox");
        await this.http.setSessionCookie(cookie);
        this.identity = await this.probeIdentity();
        if (!this.identity) {
          throw new AuthError(
            "The session imported from your browser is not valid.",
            "Open backloggd.com in that browser, confirm you are logged in, then retry.",
          );
        }
        break;
      }
      case "password": {
        await this.login();
        this.identity = await this.probeIdentity();
        if (!this.identity) {
          throw new AuthError("Logged in, but could not confirm the account identity.");
        }
        break;
      }
    }

    this.persist();
  }

  /**
   * Reuse a cookie from a previous run so restarts don't re-authenticate.
   *
   * Only when the cached session came from the credentials currently configured. Without
   * that check a stale cache silently wins over an explicitly-supplied cookie: you would
   * change BACKLOGGD_SESSION, or point the server at a different account, and it would
   * carry on acting as the previous user — including for writes.
   */
  private async tryPersistedSession(): Promise<boolean> {
    const state = this.readState();
    if (!state) return false;
    if (state.credentialFingerprint !== this.credentialFingerprint()) return false;

    try {
      await this.http.setSessionCookie(state.session);
      const identity = await this.probeIdentity();
      if (!identity) return false;
      this.identity = identity;
      return true;
    } catch {
      return false;
    }
  }

  private credentialFingerprint(): string {
    return credentialFingerprint(this.config);
  }

  private async login(): Promise<void> {
    const { username, password } = this.config;
    if (!username || !password) {
      throw new AuthError("BACKLOGGD_USERNAME and BACKLOGGD_PASSWORD are both required.");
    }

    const form = await this.http.fetch("/users/sign_in", { method: "GET" });
    const token = extractLoginToken(form.body) ?? extractCsrf(form.body);
    if (!token) {
      throw new AuthError(
        "Could not read the authenticity_token from Backloggd's login form.",
        "The login page markup may have changed.",
      );
    }

    const res = await this.http.fetch("/users/sign_in", {
      method: "POST",
      noCsrf: true,
      form: {
        authenticity_token: token,
        "user[login]": username,
        "user[password]": password,
        "user[remember_me]": "1",
      },
    });

    // Devise answers a bad login with 422 and re-renders the form.
    if (res.status === 422 || res.body.includes("Invalid Login or password")) {
      throw new AuthError(
        "Backloggd rejected those credentials.",
        "Check BACKLOGGD_USERNAME (it is your login name, not your email display name) " +
          "and BACKLOGGD_PASSWORD. Repeated failed logins may get the account " +
          "temporarily locked, so this server will not retry automatically.",
      );
    }
  }

  /**
   * Confirm we are logged in and learn who we are. `/settings/` is the only page that
   * exposes the numeric user id, so it doubles as the identity probe.
   */
  private async probeIdentity(): Promise<Identity | null> {
    // Backloggd answers /settings/ with a 404 (not a login redirect) when the session is
    // not valid, which the HTTP layer surfaces as an error. Swallow it here so the
    // caller can raise a proper AuthError explaining how to fix the credentials, rather
    // than leaking "HTTP 404 for /settings/" to the user.
    let res;
    try {
      res = await this.http.fetch("/settings/", { method: "GET" });
    } catch (err) {
      if (err instanceof HttpError) return null;
      throw err;
    }
    if (res.status !== 200) return null;
    if (!res.body.includes("/users/sign_out")) return null;

    const userId = /user_id=["']?(\d+)/.exec(res.body)?.[1];
    const username =
      /<a class="dropdown-item py-1" href="\/u\/([^/"]+)\/">Profile<\/a>/.exec(res.body)?.[1] ??
      /href="\/u\/([^/"]+)\/"/.exec(res.body)?.[1];

    if (!userId || !username) return null;
    return { username, userId };
  }

  private readState(): PersistedState | null {
    try {
      if (!existsSync(this.config.statePath)) return null;
      const parsed = JSON.parse(readFileSync(this.config.statePath, "utf8")) as PersistedState;
      return parsed.session ? parsed : null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    void (async () => {
      try {
        const session = await this.http.getSessionCookie();
        if (!session) return;
        mkdirSync(dirname(this.config.statePath), { recursive: true, mode: 0o700 });
        const state: PersistedState = {
          session,
          identity: this.identity ?? undefined,
          savedAt: Date.now(),
          credentialFingerprint: this.credentialFingerprint(),
        };
        writeFileSync(this.config.statePath, JSON.stringify(state), { mode: 0o600 });
      } catch {
        // Persistence is an optimisation; failing to cache must never break a request.
      }
    })();
  }
}

function extractLoginToken(html: string): string | null {
  const formMatch = /<form[^>]*action="\/users\/sign_in"[\s\S]*?<\/form>/.exec(html);
  const scope = formMatch?.[0] ?? html;
  return /name="authenticity_token"[^>]*value="([^"]+)"/.exec(scope)?.[1] ?? null;
}

function authHint(config: Config): string {
  if (config.authMode === "none") {
    return (
      "Configure one of: BACKLOGGD_SESSION (a _backloggd_session cookie value), " +
      "BACKLOGGD_USERNAME + BACKLOGGD_PASSWORD, or BACKLOGGD_BROWSER_IMPORT=firefox."
    );
  }
  return "Check the configured credentials and try again.";
}
