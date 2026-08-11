import { BASE_URL } from "../config.js";
import type { LibraryEntry, Page } from "../types.js";
import { intOrNull, load, makePage, slugFromHref, type Doc } from "./helpers.js";
import { readPreloadedLogNode } from "./library.js";

/**
 * Parse any page built from the standard game-card grid.
 *
 * Company catalogues, related-game frames and browse pages all reuse the same
 * `.card.game-cover` markup as the library — and, when authenticated, the same hidden
 * `#preloaded-log-{id}` block. That means a company page arrives with the caller's own
 * shelf and rating already attached, with no follow-up request.
 */
export function parseGameGrid(html: string, page = 1): Page<LibraryEntry> {
  const $ = load(html);
  const items: LibraryEntry[] = [];
  const seen = new Set<number>();

  $(".card.game-cover[game_id]").each((_, el) => {
    const card = $(el);
    const gameId = intOrNull(card.attr("game_id"));
    if (!gameId || seen.has(gameId)) return;

    const href =
      card.find("a.cover-link").attr("href") ??
      card.parent().attr("href") ??
      card.closest("a").attr("href");
    const slug = slugFromHref(href);
    if (!slug) return;
    seen.add(gameId);

    const img = card.find("img.card-img").first();
    const state = readPreloadedLogNode($(`#preloaded-log-${gameId} [data-log-id]`).first());

    items.push({
      game: {
        id: gameId,
        slug,
        title:
          img.attr("alt")?.trim() ||
          card.parent().find(".game-text-centered").first().text().trim() ||
          slug,
        coverUrl: img.attr("data-src") ?? img.attr("src") ?? null,
        url: `${BASE_URL}/games/${slug}/`,
      },
      rating: state.rating,
      status: state.status,
      liked: state.liked,
    });
  });

  return makePage(items, page, $);
}

/** Company name from a `/company/{slug}/` page. */
export function parseCompanyName($: Doc | string): string | null {
  const $$ = typeof $ === "string" ? load($) : $;
  return $$("h1").first().text().trim() || null;
}
