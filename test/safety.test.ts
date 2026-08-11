import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetConfirmations, consumeConfirmation, issueConfirmation } from "../src/confirm.js";
import { RateLimiter } from "../src/http/ratelimit.js";
import { loadConfig } from "../src/config.js";
import { CircuitOpenError } from "../src/errors.js";

describe("destructive-action confirmation", () => {
  beforeEach(() => _resetConfirmations());

  it("refuses an action that was never previewed", () => {
    expect(consumeConfirmation("remove_game", "119133", "confirm_abc")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("refuses a previewed action when no token is supplied", () => {
    issueConfirmation("remove_game", "119133");
    expect(consumeConfirmation("remove_game", "119133", undefined)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts the exact issued token", () => {
    const token = issueConfirmation("remove_game", "119133");
    expect(consumeConfirmation("remove_game", "119133", token)).toEqual({ ok: true });
  });

  it("is single use — a token cannot destroy twice", () => {
    const token = issueConfirmation("remove_game", "119133");
    expect(consumeConfirmation("remove_game", "119133", token).ok).toBe(true);
    expect(consumeConfirmation("remove_game", "119133", token)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("cannot be replayed against a different game", () => {
    const token = issueConfirmation("remove_game", "119133");
    expect(consumeConfirmation("remove_game", "999", token)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("cannot be replayed against a different action on the same game", () => {
    const token = issueConfirmation("remove_rating", "119133");
    expect(consumeConfirmation("remove_game", "119133", token)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("rejects a guessed token", () => {
    issueConfirmation("remove_game", "119133");
    expect(consumeConfirmation("remove_game", "119133", "confirm_deadbeef").ok).toBe(false);
    expect(consumeConfirmation("remove_game", "119133", "true").ok).toBe(false);
    expect(consumeConfirmation("remove_game", "119133", "yes").ok).toBe(false);
  });

  it("issues unguessable, distinct tokens", () => {
    const a = issueConfirmation("remove_game", "1");
    const b = issueConfirmation("remove_game", "2");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^confirm_[0-9a-f]{24}$/);
  });

  it("expires tokens", () => {
    vi.useFakeTimers();
    try {
      const token = issueConfirmation("remove_game", "119133");
      vi.advanceTimersByTime(6 * 60_000);
      const result = consumeConfirmation("remove_game", "119133", token);
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rate limiter", () => {
  const config = { ...loadConfig(), minRequestIntervalMs: 0, minWriteIntervalMs: 0 };

  it("serialises work in submission order", async () => {
    const limiter = new RateLimiter(config);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.schedule(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 5));
        }, false),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps running after a task throws", async () => {
    const limiter = new RateLimiter(config);
    await expect(
      limiter.schedule(() => Promise.reject(new Error("boom")), false),
    ).rejects.toThrow("boom");
    await expect(limiter.schedule(() => Promise.resolve("ok"), false)).resolves.toBe("ok");
  });

  it("opens the circuit after repeated 429s instead of hammering", async () => {
    const limiter = new RateLimiter(config);
    for (let i = 0; i < 3; i++) limiter.note429(null, 0);

    expect(limiter.status().circuitOpen).toBe(true);
    await expect(limiter.schedule(() => Promise.resolve("nope"), false)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("clears the 429 streak on success", () => {
    const limiter = new RateLimiter(config);
    limiter.note429(null, 0);
    limiter.note429(null, 0);
    limiter.noteSuccess();
    limiter.note429(null, 0);
    expect(limiter.status().circuitOpen).toBe(false);
  });

  it("honours a Retry-After header over its own backoff", () => {
    const limiter = new RateLimiter(config);
    expect(limiter.note429("42", 0)).toBe(42_000);
  });

  it("backs off exponentially without a Retry-After header", () => {
    const limiter = new RateLimiter(config);
    const first = limiter.note429(null, 0);
    limiter.noteSuccess();
    const second = limiter.note429(null, 1);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(181_000);
  });
});

describe("credential redaction", () => {
  it("never lets a session cookie or password reach a log line", async () => {
    const { redact } = await import("../src/config.js");
    const line =
      "GET / Cookie: _backloggd_session=SECRETVALUE123; X-CSRF-Token: tok123 " +
      'authenticity_token="abc123" password=hunter2';
    const safe = redact(line);
    expect(safe).not.toContain("SECRETVALUE123");
    expect(safe).not.toContain("tok123");
    expect(safe).not.toContain("abc123");
    expect(safe).not.toContain("hunter2");
    expect(safe).toContain("<redacted>");
  });
});

describe("credential fingerprinting", () => {
  /**
   * Regression test for a real bug: the persisted session cache used to be reused
   * unconditionally, so an invalid (or simply different) BACKLOGGD_SESSION would be
   * ignored and the server kept acting as the previously cached account — including
   * for writes. The cache is now keyed by this fingerprint.
   */
  const base = loadConfig();

  it("distinguishes different session cookies", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const a = credentialFingerprint({ ...base, authMode: "session", session: "cookie-a" });
    const b = credentialFingerprint({ ...base, authMode: "session", session: "cookie-b" });
    expect(a).not.toBe(b);
  });

  it("distinguishes different accounts in password mode", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const a = credentialFingerprint({
      ...base, authMode: "password", username: "alice", password: "pw",
    });
    const b = credentialFingerprint({
      ...base, authMode: "password", username: "bob", password: "pw",
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes a changed password for the same account", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const a = credentialFingerprint({
      ...base, authMode: "password", username: "alice", password: "old",
    });
    const b = credentialFingerprint({
      ...base, authMode: "password", username: "alice", password: "new",
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes auth modes even with overlapping values", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const a = credentialFingerprint({ ...base, authMode: "session", session: "x" });
    const b = credentialFingerprint({ ...base, authMode: "browser", browser: "firefox" });
    expect(a).not.toBe(b);
  });

  it("is stable for identical credentials, so restarts reuse the cache", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const cfg = { ...base, authMode: "session" as const, session: "same" };
    expect(credentialFingerprint(cfg)).toBe(credentialFingerprint({ ...cfg }));
  });

  it("never embeds the raw secret", async () => {
    const { credentialFingerprint } = await import("../src/auth/session.js");
    const fp = credentialFingerprint({
      ...base, authMode: "password", username: "alice", password: "hunter2",
    });
    expect(fp).not.toContain("hunter2");
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });
});
