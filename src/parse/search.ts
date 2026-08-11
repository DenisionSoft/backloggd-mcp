import { BASE_URL } from "../config.js";
import type { GameSummary } from "../types.js";
import { intOrNull, load, slugFromHref } from "./helpers.js";

export interface AutocompleteHit {
  id: number;
  slug: string;
  title: string;
  year: number | null;
}

/** `GET /autocomplete.json?query=` — the cheapest and cleanest game lookup available. */
export function parseAutocomplete(json: string): AutocompleteHit[] {
  let parsed: { suggestions?: { value?: string; data?: Record<string, unknown> }[] };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return [];
  }

  const out: AutocompleteHit[] = [];
  for (const s of parsed.suggestions ?? []) {
    const d = s.data ?? {};
    const id = Number(d["id"]);
    const slug = typeof d["slug"] === "string" ? d["slug"] : null;
    if (!Number.isFinite(id) || !slug) continue;
    out.push({
      id,
      slug,
      title: (typeof d["title"] === "string" ? d["title"] : s.value) ?? slug,
      year: intOrNull(typeof d["year"] === "string" ? d["year"] : null),
    });
  }
  return out;
}

export interface SearchResult extends GameSummary {
  platforms: string[];
  category: string | null;
}

/**
 * Parse the Turbo Stream from `GET /search/results/?query=…&type=games`.
 *
 * The response is a sequence of `<turbo-stream><template>…` fragments rather than a
 * page, but cheerio parses the templates' contents fine, so the same card selectors
 * apply.
 */
export function parseSearchResults(html: string): SearchResult[] {
  const $ = load(html);
  const out: SearchResult[] = [];
  const seen = new Set<number>();

  $(".result").each((_, el) => {
    const row = $(el);
    const card = row.find(".card.game-cover[game_id]").first();
    const id = intOrNull(card.attr("game_id") ?? row.find("[game_id]").first().attr("game_id"));
    const href = row.find("a[href^='/games/']").first().attr("href");
    const slug = slugFromHref(href);
    if (!id || !slug || seen.has(id)) return;
    seen.add(id);

    const nameEl = row.find(".game-name h3").first();
    const year = intOrNull(nameEl.find(".subtitle-text").first().text());
    const title = nameEl.clone().children().remove().end().text().replace(/\s+/g, " ").trim();

    const platforms: string[] = [];
    let category: string | null = null;
    row.find(".search-result-platforms .game-details-value").each((__, p) => {
      const t = $(p).text().replace(/\s+/g, " ").trim();
      if (!t) return;
      // The first chip is the game's category ("Main Game", "DLC"), the rest platforms.
      if ($(p).hasClass("game-result-type")) category = t;
      else if (!platforms.includes(t)) platforms.push(t);
    });

    out.push({
      id,
      slug,
      title: title || slug,
      year,
      coverUrl: card.find("img.card-img").attr("src") ?? null,
      url: `${BASE_URL}/games/${slug}/`,
      platforms,
      category,
    });
  });

  return out;
}
