import type { GameLog, LibraryStatus, Playthrough, UserGameEntry } from "../types.js";
import { ratingToStars } from "../types.js";
import { deriveStatus, normalisePlayedStatus } from "./library.js";
import { parseSessions } from "./sessions.js";

/** Shape of `GET /log/edit/{game_id}`, which returns JSON rather than HTML. */
interface LogEditResponse {
  game_log?: {
    id?: number;
    status?: string;
    rating?: number;
    is_play?: boolean;
    is_playing?: boolean;
    is_backlog?: boolean;
    is_wishlist?: boolean;
    game_liked?: boolean;
    total_hours?: number;
    total_minutes?: number;
  } | null;
  playthroughs?: Record<string, RawPlaythrough> | RawPlaythrough[] | null;
}

interface RawPlaythrough {
  id?: number;
  title?: string | null;
  rating?: number;
  review?: string | null;
  review_spoilers?: boolean;
  played_platform?: string | number | null;
  platform?: string | number | null;
  start_date?: string | null;
  finish_date?: string | null;
  hours_played?: number | null;
  mins_played?: number | null;
  is_replay?: boolean;
  is_master?: boolean;
  status?: string | null;
  play_dates?: unknown;
}

/**
 * Parse `GET /log/edit/{game_id}`.
 *
 * This endpoint is the single best read in the whole API: it returns the caller's
 * complete state for a game as compact JSON, where the equivalent HTML page is ~100 KB.
 */
export function parseLogEdit(json: string, gameId: number): GameLog {
  let data: LogEditResponse;
  try {
    data = JSON.parse(json) as LogEditResponse;
  } catch {
    data = {};
  }

  const log = data.game_log ?? null;

  const isPlayed = Boolean(log?.is_play);
  const isPlaying = Boolean(log?.is_playing);
  const isBacklog = Boolean(log?.is_backlog);
  const isWishlist = Boolean(log?.is_wishlist);

  const status: LibraryStatus = log
    ? deriveStatus({ isPlayed, isPlaying, isBacklog, isWishlist })
    : "none";

  const entry: UserGameEntry = {
    gameId,
    logId: log?.id ?? null,
    status,
    playedStatus: normalisePlayedStatus(log?.status),
    rating: ratingToStars(log?.rating ?? null),
    liked: Boolean(log?.game_liked),
    isBacklog,
    isWishlist,
    isPlaying,
    isPlayed,
    hoursPlayed: log?.total_hours ?? null,
    minutesPlayed: log?.total_minutes ?? null,
  };

  return { game: { id: gameId }, entry, playthroughs: normalisePlaythroughs(data.playthroughs) };
}

function normalisePlaythroughs(
  raw: LogEditResponse["playthroughs"],
): Playthrough[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list
    .filter((p): p is RawPlaythrough => Boolean(p) && typeof p === "object")
    .map((p) => ({
      id: p.id ?? 0,
      title: p.title ?? null,
      rating: ratingToStars(p.rating ?? null),
      review: p.review?.trim() || null,
      reviewHasSpoilers: Boolean(p.review_spoilers),
      platform:
        p.played_platform !== null && p.played_platform !== undefined
          ? String(p.played_platform)
          : p.platform !== null && p.platform !== undefined
            ? String(p.platform)
            : null,
      startDate: p.start_date ?? null,
      finishDate: p.finish_date ?? null,
      hoursPlayed: p.hours_played ?? null,
      minutesPlayed: p.mins_played ?? null,
      isReplay: Boolean(p.is_replay),
      isMastered: Boolean(p.is_master),
      status: normalisePlayedStatus(p.status),
      // Dated play sessions. Previously fetched and discarded — this is the data
      // behind the journal view.
      sessions: parseSessions(p.play_dates),
    }));
}

/** Shape of `POST /api/user/games/logs`, the batch state lookup. */
export function parseBatchLogs(json: string): Map<number, UserGameEntry> {
  const out = new Map<number, UserGameEntry>();
  let data: Record<string, Record<string, unknown>>;
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return out;
  }

  for (const [key, v] of Object.entries(data)) {
    const gameId = Number.parseInt(key, 10);
    if (!Number.isFinite(gameId) || !v || typeof v !== "object") continue;

    const isPlayed = Boolean(v["is_play"]);
    const isPlaying = Boolean(v["is_playing"]);
    const isBacklog = Boolean(v["is_backlog"]);
    const isWishlist = Boolean(v["is_wishlist"]);

    out.set(gameId, {
      gameId,
      logId: typeof v["game_log_id"] === "number" ? v["game_log_id"] : null,
      status: deriveStatus({ isPlayed, isPlaying, isBacklog, isWishlist }),
      playedStatus: normalisePlayedStatus(
        typeof v["status_title"] === "string" ? v["status_title"] : null,
      ),
      rating: ratingToStars(typeof v["rating"] === "number" ? v["rating"] : null),
      liked: Boolean(v["is_liked"]),
      isBacklog,
      isWishlist,
      isPlaying,
      isPlayed,
      hoursPlayed: null,
      minutesPlayed: null,
    });
  }
  return out;
}
