import { BASE_URL } from "../config.js";
import type { GameList, GameSummary, Page } from "../types.js";
import { intOrNull, load, makePage, slugFromHref } from "./helpers.js";

/** Parse `/u/{name}/lists/…` — the index of a user's lists. */
export function parseListsPage(html: string, page: number): Page<GameList> {
  const $ = load(html);
  const items: GameList[] = [];

  $(".list-col").each((_, el) => {
    const col = $(el);
    const link = col.find("h2.list-display-title a").first();
    const href = link.attr("href");
    if (!href) return;

    const slug = /\/list\/([^/?#]+)/.exec(href)?.[1];
    if (!slug) return;

    // "25 Games" → 25.
    const count = intOrNull(col.find(".entries-count").first().text());

    items.push({
      slug,
      name: link.text().replace(/\s+/g, " ").trim() || slug,
      url: new URL(href, BASE_URL).toString(),
      gameCount: count,
      likeCount: intOrNull(col.find(".like-counter, .likes-count").first().text()),
      description: null,
      isPrivate: col.find(".fa-lock, .private-icon").length > 0,
    });
  });

  return makePage(items, page, $);
}

export interface ListDetail {
  slug: string;
  name: string;
  url: string;
  description: string | null;
  games: GameSummary[];
  page: number;
  hasMore: boolean;
}

/** Parse a single list page, `/u/{name}/list/{slug}/`. */
export function parseListDetail(
  html: string,
  username: string,
  slug: string,
  page: number,
): ListDetail {
  const $ = load(html);
  const games: GameSummary[] = [];
  const seen = new Set<string>();

  $(".card.game-cover").each((_, el) => {
    const card = $(el);
    const href = card.find("a.cover-link").attr("href") ?? card.parent().attr("href");
    const s = slugFromHref(href);
    if (!s || seen.has(s)) return;
    seen.add(s);

    const img = card.find("img.card-img").first();
    games.push({
      id: intOrNull(card.attr("game_id")) ?? 0,
      slug: s,
      title: img.attr("alt")?.trim() || s,
      year: null,
      coverUrl: img.attr("src") ?? null,
      url: `${BASE_URL}/games/${s}/`,
    });
  });

  return {
    slug,
    name: $("h1.list-title, .list-name h1").first().text().trim() || slug,
    url: `${BASE_URL}/u/${username}/list/${slug}/`,
    description: $(".list-description, #list-description").first().text().trim() || null,
    games,
    page,
    hasMore: makePage(games, page, $).hasMore,
  };
}
