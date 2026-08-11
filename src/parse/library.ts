import { BASE_URL } from "../config.js";
import type { LibraryEntry, LibraryStatus, Page, PlayedStatus } from "../types.js";
import { ratingToStars } from "../types.js";
import { intOrNull, load, makePage, slugFromHref, type Doc, type Node } from "./helpers.js";

/**
 * Parse a user library grid (`/u/{name}/games/…`, `/playing/`, `/backlog/`, `/wishlist/`).
 *
 * Each card is accompanied by a hidden `#preloaded-log-{id}` block holding the whole
 * entry as data attributes — rating, log id, status title, and a timestamp-or-empty
 * flag per shelf. Reading that is far more robust than inferring state from which CSS
 * classes happen to be on the buttons.
 */
export function parseLibraryPage(html: string, page: number): Page<LibraryEntry> {
  const $ = load(html);
  const items: LibraryEntry[] = [];

  $(".card.game-cover[game_id]").each((_, el) => {
    const card = $(el);
    const gameId = intOrNull(card.attr("game_id"));
    if (!gameId) return;

    const href = card.find("a.cover-link").attr("href");
    const slug = slugFromHref(href);
    if (!slug) return;

    const img = card.find("img.card-img").first();
    const title =
      img.attr("alt")?.trim() ||
      card.parent().find(".game-text-centered").first().text().trim() ||
      slug;

    const state = readPreloadedLog($, gameId);

    items.push({
      game: {
        id: gameId,
        slug,
        title,
        year: null,
        coverUrl: img.attr("src") ?? null,
        url: `${BASE_URL}/games/${slug}/`,
      },
      rating: state.rating,
      status: state.status,
      liked: state.liked,
    });
  });

  return makePage(items, page, $);
}

export interface PreloadedLog {
  logId: number | null;
  rating: number | null;
  status: LibraryStatus;
  playedStatus: PlayedStatus | null;
  liked: boolean;
  isPlayed: boolean;
  isPlaying: boolean;
  isBacklog: boolean;
  isWishlist: boolean;
}

/**
 * Read `#preloaded-log-{gameId}`.
 *
 * The shelf flags are not booleans: Backloggd emits the timestamp at which the game
 * entered that shelf, or an empty string when it is not on it. So presence-of-text is
 * the test, not truthiness of the attribute.
 */
export function readPreloadedLog($: Doc, gameId: number): PreloadedLog {
  const block = $(`#preloaded-log-${gameId} [data-log-id]`).first();
  return readPreloadedLogNode(block);
}

export function readPreloadedLogNode(block: Node): PreloadedLog {
  const flag = (name: string): boolean => {
    const v = block.attr(name);
    return typeof v === "string" && v.trim().length > 0;
  };

  const isPlayed = flag("data-is-play");
  const isPlaying = flag("data-is-playing");
  const isBacklog = flag("data-is-backlog");
  const isWishlist = flag("data-is-wishlist");

  const statusTitle = block.attr("data-status-title")?.trim().toLowerCase();
  const playedStatus = normalisePlayedStatus(statusTitle);

  return {
    logId: intOrNull(block.attr("data-log-id")),
    rating: ratingToStars(intOrNull(block.attr("data-rating"))),
    status: deriveStatus({ isPlayed, isPlaying, isBacklog, isWishlist }),
    playedStatus,
    liked: flag("data-is-liked"),
    isPlayed,
    isPlaying,
    isBacklog,
    isWishlist,
  };
}

/**
 * A game can sit on several shelves at once (a replay might be both played and
 * playing). Report the most specific single status, in the order the UI itself
 * prioritises the buttons.
 */
export function deriveStatus(f: {
  isPlayed: boolean;
  isPlaying: boolean;
  isBacklog: boolean;
  isWishlist: boolean;
}): LibraryStatus {
  if (f.isPlaying) return "playing";
  if (f.isPlayed) return "played";
  if (f.isBacklog) return "backlog";
  if (f.isWishlist) return "wishlist";
  return "none";
}

export function normalisePlayedStatus(raw: string | undefined | null): PlayedStatus | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const known: PlayedStatus[] = ["played", "completed", "retired", "shelved", "abandoned"];
  return known.find((k) => k === v) ?? null;
}
