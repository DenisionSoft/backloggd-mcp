import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two-phase confirmation for destructive actions.
 *
 * The problem this solves: a `confirm: true` boolean is worthless as a safety gate,
 * because the model can simply set it. So instead the first call *cannot* perform the
 * action at all — it reads back exactly what would be destroyed and returns that
 * preview along with a server-generated token. Only a second call carrying that exact
 * token proceeds.
 *
 * The token is unguessable and never appears in a tool's input schema, so the only way
 * to obtain one is to make the preview call and read the result. That forces the
 * destructive operation to become visible in the conversation before it can happen,
 * which gives the user a real chance to stop it.
 *
 * Tokens are single-use, expire quickly, and are bound to the specific action and
 * target — a token minted for deleting one game cannot be replayed against another.
 */

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 32;

interface Pending {
  token: string;
  action: string;
  target: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [key, p] of pending) {
    if (p.expiresAt <= now) pending.delete(key);
  }
  // Bound the map so a long-running server can't accumulate stale entries.
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

function key(action: string, target: string): string {
  return `${action}::${target}`;
}

/** Mint a token for (action, target). Overwrites any previous token for the same pair. */
export function issueConfirmation(action: string, target: string): string {
  sweep();
  const token = `confirm_${randomBytes(12).toString("hex")}`;
  pending.set(key(action, target), {
    token,
    action,
    target,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "expired" | "mismatch" };

/**
 * Validate and burn a token. Single-use: a successful consume removes it, so a repeated
 * call cannot silently destroy something twice.
 */
export function consumeConfirmation(
  action: string,
  target: string,
  supplied: string | undefined,
): ConsumeResult {
  sweep();
  const k = key(action, target);
  const entry = pending.get(k);
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.expiresAt <= Date.now()) {
    pending.delete(k);
    return { ok: false, reason: "expired" };
  }
  if (!supplied) return { ok: false, reason: "mismatch" };

  const a = Buffer.from(entry.token);
  const b = Buffer.from(supplied);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) return { ok: false, reason: "mismatch" };

  pending.delete(k);
  return { ok: true };
}

/** Test seam. */
export function _resetConfirmations(): void {
  pending.clear();
}
