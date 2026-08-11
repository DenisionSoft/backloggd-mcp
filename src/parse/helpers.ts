import * as cheerio from "cheerio";
import { BASE_URL } from "../config.js";
import type { GameSummary, Page } from "../types.js";

export type Doc = cheerio.CheerioAPI;
export type Node = ReturnType<Doc>;

export function load(html: string): Doc {
  return cheerio.load(html);
}

export function text($el: Node): string | null {
  const t = $el.first().text().replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

export function intOrNull(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function absoluteUrl(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return new URL(path, BASE_URL).toString();
  } catch {
    return null;
  }
}

export function slugFromHref(href: string | undefined): string | null {
  if (!href) return null;
  return /\/games\/([^/?#]+)/.exec(href)?.[1] ?? null;
}

/**
 * Backloggd renders star ratings as two stacked rows of five stars, where the visible
 * fraction of the top row *is* the rating: `<div class="stars-top" style="width:90%">`
 * means 4.5/5. There is no numeric attribute anywhere, so this width is the only
 * source of truth on list and review markup.
 */
export function starsFromWidth($: Doc, scope: Node): number | null {
  const style = scope.find(".stars-top").first().attr("style");
  if (!style) return null;
  const pct = /width:\s*([\d.]+)%/.exec(style)?.[1];
  if (!pct) return null;
  const value = (Number.parseFloat(pct) / 100) * 5;
  if (!Number.isFinite(value) || value <= 0) return null;
  // Snap to the half-star grid the site actually uses.
  return Math.round(value * 2) / 2;
}

/**
 * Look up a game-detail row by its header text ("Genres", "Platforms", "Released").
 * Matching on the label rather than on position keeps this working when rows are
 * reordered or conditionally hidden, which they are — the page renders a mobile and a
 * desktop copy of several rows.
 */
export function detailRowValues($: Doc, header: string): string[] {
  const values: string[] = [];
  $(".game-details-header").each((_, el) => {
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (label.toLowerCase() !== header.toLowerCase()) return;
    const row = $(el).closest(".row");
    row.find(".game-details-value").each((__, v) => {
      const t = $(v).text().replace(/\s+/g, " ").trim();
      if (t && !values.includes(t)) values.push(t);
    });
  });
  return values;
}

/** Read a `<meta>` value by `property` or `name`. */
export function meta($: Doc, key: string): string | null {
  return (
    $(`meta[property="${key}"]`).attr("content") ??
    $(`meta[name="${key}"]`).attr("content") ??
    null
  );
}

/** The `schema.org/AggregateRating` block, present on game pages that have ratings. */
export function aggregateRating($: Doc): { value: number; count: number } | null {
  let found: { value: number; count: number } | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const data = JSON.parse($(el).text()) as {
        "@type"?: string;
        ratingValue?: string | number;
        ratingCount?: string | number;
      };
      if (data["@type"] !== "AggregateRating") return;
      const value = Number(data.ratingValue);
      const count = Number(data.ratingCount);
      if (Number.isFinite(value)) {
        found = { value, count: Number.isFinite(count) ? count : 0 };
      }
    } catch {
      // A malformed block is not worth failing the whole page over.
    }
  });
  return found;
}

/** Extract the game description from the ld+json block, which carries the full text. */
export function descriptionFromLd($: Doc): string | null {
  let found: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const data = JSON.parse($(el).text()) as { itemReviewed?: { description?: string } };
      const d = data.itemReviewed?.description;
      if (typeof d === "string" && d.trim()) found = d.trim();
    } catch {
      /* ignore */
    }
  });
  return found;
}

/**
 * Read a game card (`.card.game-cover`), the unit that library, list, search and
 * journal pages are all built from.
 */
export function gameFromCard($: Doc, card: Node): GameSummary | null {
  const id = intOrNull(card.attr("game_id"));
  const img = card.find("img.card-img").first();
  const href =
    card.find("a.cover-link").attr("href") ??
    card.closest("a").attr("href") ??
    card.parent().find("a[href^='/games/']").first().attr("href");

  const slug = slugFromHref(href);
  const title = img.attr("alt")?.trim() || null;

  if (!id && !slug) return null;

  return {
    id: id ?? 0,
    slug: slug ?? "",
    title: title ?? slug ?? "Unknown",
    year: null,
    coverUrl: img.attr("src") ?? null,
    url: slug ? `${BASE_URL}/games/${slug}/` : BASE_URL,
  };
}

/**
 * Decide whether another page exists.
 *
 * Backloggd uses Pagy, whose "Next" link is rendered without an href when you are on
 * the last page. Crucially it also *re-serves the final page indefinitely* for
 * out-of-range page numbers, so "the response was non-empty" is not a termination
 * condition — callers additionally compare item ids against the previous page.
 */
export function hasNextPage($: Doc): boolean {
  const next = $('nav.pagy a[aria-label="Next"], nav.pagy a:contains("Next")').first();
  if (next.length === 0) return false;
  if (next.attr("aria-disabled") === "true") return false;
  return Boolean(next.attr("href"));
}

export function totalPages($: Doc): number | null {
  let max: number | null = null;
  $("nav.pagy a").each((_, el) => {
    const n = Number.parseInt($(el).text().trim(), 10);
    if (Number.isFinite(n)) max = max === null ? n : Math.max(max, n);
  });
  return max;
}

export function makePage<T>(items: T[], page: number, $: Doc): Page<T> {
  return { items, page, hasMore: hasNextPage($), totalPages: totalPages($) };
}
