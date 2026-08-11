import { BASE_URL } from "../config.js";
import type { Page, Review } from "../types.js";
import { intOrNull, load, makePage, starsFromWidth } from "./helpers.js";

/**
 * Parse review cards. The same `.review-card` markup is used by the per-game reviews
 * turbo-frame (`/reviews/preview/{slug}/`) and by a user's own reviews page, so one
 * parser serves both.
 */
export function parseReviews(html: string, page: number): Page<Review> {
  const $ = load(html);
  const items: Review[] = [];

  $(".review-card").each((_, el) => {
    const card = $(el);

    const authorHref = card.find("a[href^='/u/']").first().attr("href");
    const author = /\/u\/([^/?#]+)/.exec(authorHref ?? "")?.[1];
    if (!author) return;

    const reviewLink = card.find("a.review-game-link").first().attr("href");
    const reviewId = intOrNull(/\/review\/(\d+)/.exec(reviewLink ?? "")?.[1]);

    const gameLink = card.find("a[href^='/games/']").first().attr("href");
    const gameSlug = /\/games\/([^/?#]+)/.exec(gameLink ?? "")?.[1] ?? null;

    const body = card
      .find(".review-body, .card-text, .review-content")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    items.push({
      id: reviewId,
      author,
      authorUrl: `${BASE_URL}/u/${author}/`,
      gameTitle: card.find(".review-game-name").first().text().trim() || null,
      gameSlug,
      rating: starsFromWidth($, card),
      body,
      hasSpoilers: card.find(".spoiler-warning, .review-spoiler").length > 0,
      likeCount: intOrNull(card.find(".like-counter, [like_counter_text]").first().text()),
      date: card.find("time").first().attr("datetime") ?? null,
      url: reviewLink ? new URL(reviewLink, BASE_URL).toString() : null,
    });
  });

  return makePage(items, page, $);
}
