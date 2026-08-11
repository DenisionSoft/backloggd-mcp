import { normalisePlayedStatus } from "./library.js";
import type { PlayedStatus } from "../types.js";

/**
 * A dated play session.
 *
 * Backloggd nests these inside a playthrough as `play_dates`. Each is a date *range*
 * (`range_start_date` … `range_end_date`) rather than a single day, and separately
 * carries `start_date`/`finish_date` flags marking the session where the playthrough
 * began or ended.
 */
export interface PlaySession {
  id: number;
  /** Inclusive first day of the session, `YYYY-MM-DD`. */
  startDate: string | null;
  /** Backloggd stores this as exclusive-end; we normalise to the last played day. */
  endDate: string | null;
  hours: number | null;
  minutes: number | null;
  note: string | null;
  status: PlayedStatus | null;
  tags: string[];
  privacy: string | null;
  /** True when this session marks the playthrough's start / finish. */
  marksStart: boolean;
  marksFinish: boolean;
}

interface RawSession {
  id?: number;
  range_start_date?: string | null;
  range_end_date?: string | null;
  start_date?: string | null;
  finish_date?: string | null;
  hours?: number | string | null;
  minutes?: number | string | null;
  note?: string | null;
  status?: string | null;
  tags?: unknown;
  privacy?: string | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/** Shift a `YYYY-MM-DD` by whole days without pulling in a date library. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map((p) => Number.parseInt(p, 10));
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function parseSessions(raw: unknown): PlaySession[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is RawSession => Boolean(s) && typeof s === "object")
    .map((s) => {
      const start = s.range_start_date ?? null;
      // range_end_date is exclusive in Backloggd's calendar model — a single-day
      // session spans [day, day+1). Report the last day actually played.
      const rawEnd = s.range_end_date ?? null;
      const end = rawEnd && start && rawEnd !== start ? shiftDate(rawEnd, -1) : (rawEnd ?? start);

      return {
        id: s.id ?? 0,
        startDate: start,
        endDate: end,
        hours: num(s.hours),
        minutes: num(s.minutes),
        note: s.note?.trim() || null,
        status: normalisePlayedStatus(s.status),
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [],
        privacy: s.privacy ?? null,
        marksStart: Boolean(s.start_date),
        marksFinish: Boolean(s.finish_date),
      };
    });
}

/**
 * Build the `dates[playthroughId][index][...]` form fields the log-save endpoint expects.
 *
 * Only sessions marked `edited` are persisted by the server, so every session we send
 * carries that flag.
 */
export function buildSessionFields(
  playthroughId: number | string,
  sessions: {
    id: number;
    startDate: string;
    endDate?: string;
    hours?: number;
    minutes?: number;
    note?: string;
    status?: PlayedStatus;
  }[],
): Record<string, string> {
  const form: Record<string, string> = {};
  sessions.forEach((s, i) => {
    const p = `dates[${playthroughId}][${i}]`;
    const end = s.endDate ?? s.startDate;
    form[`${p}[id]`] = String(s.id);
    form[`${p}[range_start_date]`] = s.startDate;
    // Exclusive end: a one-day session ends the following day.
    form[`${p}[range_end_date]`] = shiftDate(end, 1);
    form[`${p}[edited]`] = "true";
    form[`${p}[note]`] = s.note ?? "";
    form[`${p}[hours]`] = s.hours === undefined ? "" : String(s.hours);
    form[`${p}[minutes]`] = s.minutes === undefined ? "" : String(s.minutes);
    form[`${p}[status]`] = s.status ?? "";
    form[`${p}[start_date]`] = "";
    form[`${p}[finish_date]`] = "";
  });
  return form;
}
