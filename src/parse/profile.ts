import { BASE_URL } from "../config.js";
import { ParseError } from "../errors.js";
import type { GameSummary, JournalEntry, Page, UserProfile } from "../types.js";
import { ratingToStars } from "../types.js";
import { intOrNull, load, makePage, meta, slugFromHref, type Doc, type Node } from "./helpers.js";
import { readPreloadedLogNode } from "./library.js";

/** Parse `/u/{name}/`. */
export function parseProfile(html: string, username: string): UserProfile {
  const $ = load(html);
  if (!$("#profile-stats, #profile-sidebar").length) {
    throw new ParseError("user profile", `${BASE_URL}/u/${username}/`);
  }

  // #profile-stats is three columns of <h1>count</h1><h4>label</h4>. Match on the label
  // rather than column order, since the labels include a year that changes annually.
  const stats = new Map<string, number | null>();
  $("#profile-stats > div").each((_, el) => {
    const col = $(el);
    const label = col.find("h4").first().text().replace(/\s+/g, " ").trim().toLowerCase();
    const value = intOrNull(col.find("h1").first().text());
    if (label) stats.set(label, value);
  });

  const stat = (needle: string): number | null => {
    for (const [k, v] of stats) if (k.includes(needle)) return v;
    return null;
  };

  const favorites: GameSummary[] = [];
  $("#profile-favorites .card.game-cover").each((_, el) => {
    const card = $(el);
    const slug = slugFromHref(card.find("a.cover-link").attr("href") ?? card.parent().attr("href"));
    if (!slug) return;
    const img = card.find("img.card-img").first();
    favorites.push({
      id: intOrNull(card.attr("game_id")) ?? 0,
      slug,
      title: img.attr("alt")?.trim() || slug,
      coverUrl: img.attr("data-src") ?? img.attr("src") ?? null,
      url: `${BASE_URL}/games/${slug}/`,
    });
  });

  return {
    username,
    url: `${BASE_URL}/u/${username}/`,
    displayName: $("#profile-name h1, .profile-username").first().text().trim() || username,
    bio: $("#bio-body").first().text().replace(/\s+/g, " ").trim() || null,
    avatarUrl: meta($, "og:image"),
    totalGames: stat("played"),
    gamesThisYear: stat("played in"),
    backlogCount: stat("backlog"),
    favorites,
  };
}

/**
 * Parse `/u/{name}/journal/` — a date-grouped play history.
 *
 * The day number lives in a `.date-entry` heading that is shared by every row beneath
 * it, so we carry the last-seen date forward as we walk rows in document order.
 */
export function parseJournal(html: string, page: number): Page<JournalEntry> {
  const $ = load(html);
  const items: JournalEntry[] = [];

  let currentDate: string | null = null;
  const monthHeading = $(".journal-month, .date-month").first().text().trim() || null;

  $(".date-entry, .card.game-cover[game_id]").each((_, el) => {
    const node = $(el);

    if (node.hasClass("date-entry")) {
      const day = node.find(".date-day").first().text().trim() || node.text().trim();
      currentDate = monthHeading && day ? `${monthHeading} ${day}` : day || null;
      return;
    }

    const gameId = intOrNull(node.attr("game_id"));
    const slug = slugFromHref(node.parent().attr("href") ?? node.find("a").attr("href"));
    if (!gameId || !slug) return;

    const row = node.closest(".row");
    const img = node.find("img.card-img").first();
    const state = readPreloadedLogNode($(`#preloaded-log-${gameId} [data-log-id]`).first());

    items.push({
      date: currentDate,
      game: {
        id: gameId,
        slug,
        title: img.attr("alt")?.trim() || row.find(".game-name a").first().text().trim() || slug,
        coverUrl: img.attr("src") ?? null,
        url: `${BASE_URL}/games/${slug}/`,
      },
      platform: row.find(".journal-platform").first().text().replace(/\s+/g, " ").trim() || null,
      rating: state.rating ?? ratingFromRow($, row),
      status: state.playedStatus,
    });
  });

  return makePage(items, page, $);
}

function ratingFromRow($: Doc, row: Node): number | null {
  return ratingToStars(intOrNull(row.find("[data-rating]").first().attr("data-rating")));
}
