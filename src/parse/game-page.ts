import { BASE_URL } from "../config.js";
import { ParseError } from "../errors.js";
import type { GameDetail } from "../types.js";
import {
  aggregateRating,
  descriptionFromLd,
  detailRowValues,
  intOrNull,
  load,
  meta,
  type Doc,
} from "./helpers.js";

/**
 * Community playtime, in hours. Backloggd shows three figures in the "Time Played"
 * cards; any of them can be absent for a game nobody has tracked.
 */
export interface Playtime {
  averageHours: number | null;
  hoursToFinish: number | null;
  hoursToMaster: number | null;
}

/** How many ratings fell in each half-star bucket, keyed "0.5" … "5". */
export type RatingDistribution = Record<string, number>;

/**
 * Parse the time cards.
 *
 * Each card is a `.stat-value` followed by a `.label` naming which figure it is
 * ("average", "to finish", "to master"). The page renders a mobile and a desktop copy,
 * so labels repeat — first occurrence wins.
 */
export function parsePlaytime($: Doc): Playtime {
  const out: Playtime = { averageHours: null, hoursToFinish: null, hoursToMaster: null };

  $(".time-played .stat-value.element-revealed").each((_, el) => {
    const value = $(el).text().trim();
    const hours = /^([\d.]+)\s*h/i.exec(value)?.[1];
    const label = $(el).closest(".time-played").find(".label").first().text().trim().toLowerCase();
    if (!hours) return;
    const n = Number.parseFloat(hours);
    if (!Number.isFinite(n)) return;
    if (label === "average" && out.averageHours === null) out.averageHours = n;
    else if (label === "to finish" && out.hoursToFinish === null) out.hoursToFinish = n;
    else if (label === "to master" && out.hoursToMaster === null) out.hoursToMaster = n;
  });

  return out;
}

/**
 * Parse the rating histogram.
 *
 * The counts exist only inside the bars' tooltip text — there is no numeric attribute:
 * `data-tippy-content="398 | 0.5 ★ Ratings (0.3%)"`. Buckets repeat across the mobile
 * and desktop copies of the chart, so we keep the first value seen per bucket.
 */
export function parseRatingDistribution(html: string): RatingDistribution | null {
  const out: RatingDistribution = {};
  const re = /data-tippy-content="(\d+)\s*\|\s*([\d.]+)\s*★\s*Ratings/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const bucket = String(Number.parseFloat(m[2] as string));
    if (!Object.hasOwn(out, bucket)) out[bucket] = Number.parseInt(m[1] as string, 10);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse `/games/{slug}/` into structured metadata. */
export function parseGamePage(html: string, slug: string): GameDetail {
  const $ = load(html);

  const title =
    $(".game-title-section h1").first().text().trim() ||
    $("h1").first().text().trim() ||
    meta($, "og:title")?.replace(/\s*\(\d{4}\)\s*$/, "").trim() ||
    null;

  if (!title) throw new ParseError("game title", `${BASE_URL}/games/${slug}/`);

  const id = gameId($);
  const agg = aggregateRating($);

  // Companies appear in the subtitle as /company/ links; Backloggd does not label which
  // are developers and which are publishers, so we report them under developers and
  // leave publishers empty rather than guessing wrong.
  const companies: string[] = [];
  $(".game-subtitle a[href^='/company/']").each((_, el) => {
    const name = $(el).text().trim();
    if (name && !companies.includes(name)) companies.push(name);
  });

  const platforms: string[] = [];
  $("#game-page-platforms .game-page-platform").each((_, el) => {
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (name && !platforms.includes(name)) platforms.push(name);
  });
  if (platforms.length === 0) platforms.push(...detailRowValues($, "Platforms"));

  const yearText = $(".game-subtitle .game-year").first().text().trim();
  const released = detailRowValues($, "Released")[0] ?? null;

  return {
    id: id ?? 0,
    slug,
    title,
    year: intOrNull(yearText) ?? (released ? intOrNull(/(\d{4})/.exec(released)?.[1]) : null),
    coverUrl: meta($, "og:image"),
    url: `${BASE_URL}/games/${slug}/`,
    description:
      descriptionFromLd($) ?? ($("#collapseSummary p").first().text().trim() || null),
    genres: detailRowValues($, "Genres"),
    platforms,
    developers: companies,
    publishers: [],
    releaseDate: released,
    category: $(".game-result-type").first().text().trim() || null,
    averageRating: agg ? Math.round(agg.value * 100) / 100 : null,
    ratingCount: agg?.count ?? null,
    playtime: parsePlaytime($),
    ratingDistribution: parseRatingDistribution(html),
  };
}

/**
 * The numeric game id is sprinkled across the page as a `game_id` attribute on the
 * logging controls. Any of them will do; they all refer to the page's game.
 */
function gameId($: Doc): number | null {
  const candidates = [
    $(".game-id-container").attr("game_id"),
    $("[game_id]").first().attr("game_id"),
    $(".log-editor-btn").attr("game_id"),
  ];
  for (const c of candidates) {
    const n = intOrNull(c);
    if (n) return n;
  }
  return null;
}

/** True when the page was rendered for a signed-in user. */
export function isAuthenticatedPage(html: string): boolean {
  return html.includes("/users/sign_out");
}
