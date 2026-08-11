import { CircuitOpenError } from "../errors.js";
import type { Config } from "../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client-side throttle whose job is to keep the user's account in good standing.
 *
 * Three independent protections, in order of how early they fire:
 *
 *  1. Serialisation + minimum spacing. Every request goes through one queue, one at a
 *     time, with a floor on the gap between them. We never open parallel connections.
 *  2. Write budgets. Writes are additionally capped per minute and per hour, because
 *     Backloggd's own 429s ("You are following users too quickly") are per-action and
 *     bulk writes are what actually trip them.
 *  3. Circuit breaker. If we still collect several 429s in a row, we stop making
 *     requests entirely for a cooldown. Continuing to poke an endpoint that is already
 *     rate limiting you is the behaviour that escalates into a restriction.
 */
export class RateLimiter {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private lastWriteAt = 0;
  private writeTimestamps: number[] = [];
  private consecutive429 = 0;
  private circuitOpenUntil = 0;

  /** Set from a `Retry-After` header; blocks everything until it passes. */
  private globalPauseUntil = 0;

  private static readonly CIRCUIT_TRIP_THRESHOLD = 3;
  private static readonly CIRCUIT_COOLDOWN_MS = 15 * 60_000;

  constructor(private readonly config: Config) {}

  /** Run `fn` under the throttle. Calls are serialised in submission order. */
  async schedule<T>(fn: () => Promise<T>, isWrite: boolean): Promise<T> {
    const run = this.queue.then(async () => {
      await this.waitForTurn(isWrite);
      if (isWrite) {
        this.lastWriteAt = Date.now();
        this.writeTimestamps.push(this.lastWriteAt);
      }
      this.lastRequestAt = Date.now();
      return fn();
    });
    // Keep the chain alive even when a caller rejects, so one failure doesn't wedge
    // the queue for every subsequent request.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitForTurn(isWrite: boolean): Promise<void> {
    const now = Date.now();

    if (this.circuitOpenUntil > now) {
      throw new CircuitOpenError(this.circuitOpenUntil);
    }

    const waits: number[] = [];

    if (this.globalPauseUntil > now) waits.push(this.globalPauseUntil - now);

    const sinceLast = now - this.lastRequestAt;
    if (sinceLast < this.config.minRequestIntervalMs) {
      waits.push(this.config.minRequestIntervalMs - sinceLast);
    }

    if (isWrite) {
      const sinceWrite = now - this.lastWriteAt;
      if (sinceWrite < this.config.minWriteIntervalMs) {
        waits.push(this.config.minWriteIntervalMs - sinceWrite);
      }
      waits.push(this.writeBudgetDelay(now));
    }

    const wait = Math.max(0, ...waits);
    if (wait > 0) await sleep(wait);
  }

  /** How long until a write would fit inside both the per-minute and per-hour budgets. */
  private writeBudgetDelay(now: number): number {
    const hourAgo = now - 3_600_000;
    this.writeTimestamps = this.writeTimestamps.filter((t) => t > hourAgo);

    const minuteAgo = now - 60_000;
    const inLastMinute = this.writeTimestamps.filter((t) => t > minuteAgo);

    let delay = 0;
    if (inLastMinute.length >= this.config.maxWritesPerMinute) {
      const oldest = inLastMinute[0];
      if (oldest !== undefined) delay = Math.max(delay, oldest + 60_000 - now);
    }
    if (this.writeTimestamps.length >= this.config.maxWritesPerHour) {
      const oldest = this.writeTimestamps[0];
      if (oldest !== undefined) delay = Math.max(delay, oldest + 3_600_000 - now);
    }
    return delay;
  }

  /** Called by the client on every 429. Returns how long the caller should back off. */
  note429(retryAfterHeader: string | null, attempt: number): number {
    this.consecutive429 += 1;

    let waitMs: number;
    const headerSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
      waitMs = headerSeconds * 1000;
    } else {
      // 5s, 15s, 45s, 135s… with jitter, capped.
      waitMs = Math.min(5000 * 3 ** attempt, 180_000);
      waitMs += Math.random() * 1000;
    }

    if (this.consecutive429 >= RateLimiter.CIRCUIT_TRIP_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + RateLimiter.CIRCUIT_COOLDOWN_MS;
    }
    this.globalPauseUntil = Math.max(this.globalPauseUntil, Date.now() + waitMs);
    return waitMs;
  }

  /** Any 2xx clears the 429 streak. */
  noteSuccess(): void {
    this.consecutive429 = 0;
  }

  status(): {
    circuitOpen: boolean;
    resumesAt: number | null;
    writesLastMinute: number;
    writesLastHour: number;
  } {
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    const minuteAgo = now - 60_000;
    const recent = this.writeTimestamps.filter((t) => t > hourAgo);
    return {
      circuitOpen: this.circuitOpenUntil > now,
      resumesAt: this.circuitOpenUntil > now ? this.circuitOpenUntil : null,
      writesLastMinute: recent.filter((t) => t > minuteAgo).length,
      writesLastHour: recent.length,
    };
  }
}
