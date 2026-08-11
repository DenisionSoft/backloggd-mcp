import { BackloggdError } from "./errors.js";
import { CATEGORIES, GENRES, PLATFORMS } from "./vocab.js";

export type Shelf = "played" | "playing" | "backlog" | "wishlist";
export type CompletionStatus = "played" | "completed" | "retired" | "shelved" | "abandoned";

export type LibrarySort =
  | "added"
  | "title"
  | "release"
  | "rating"
  | "user-rating"
  | "popular"
  | "trending"
  | "last_played"
  | "time"
  | "avg-play-time"
  | "avg-finish-time"
  | "shuffle";

export const LIBRARY_SORTS: LibrarySort[] = [
  "added", "title", "release", "rating", "user-rating", "popular", "trending",
  "last_played", "time", "avg-play-time", "avg-finish-time", "shuffle",
];

export interface LibraryQuery {
  shelf?: Shelf;
  completionStatus?: CompletionStatus;
  /** Platform the game *released* on. Accepts a slug or a display name. */
  releasePlatform?: string;
  /** Platform *you* played it on. Empty for unplayed games — rarely what you want. */
  playedPlatform?: string;
  genre?: string;
  releaseYear?: string;
  playedYear?: string;
  /** 0.5–5 stars; converted to Backloggd's 1–10 internally. */
  ratingStars?: number;
  category?: string;
  /** `games` excludes DLC and other extras; `extras` is the inverse. */
  categories?: "games" | "extras" | "all";
  sort?: LibrarySort;
  order?: "asc" | "desc";
}

/**
 * Resolve a user-supplied platform or genre to the slug the filter grammar needs.
 *
 * Accepts the slug itself, the exact display name, or a close-enough name ("quest 3",
 * "ps5", "playstation 5"). An unknown value throws with suggestions rather than being
 * passed through — Backloggd answers an unrecognised slug with HTTP 500, so guessing
 * turns a typo into an opaque server error.
 */
export function resolveSlug(
  input: string,
  table: Readonly<Record<string, string>>,
  kind: string,
): string {
  const raw = input.trim();
  if (!raw) throw new BackloggdError(`Empty ${kind}.`, "BAD_INPUT");

  if (Object.hasOwn(table, raw)) return raw;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const target = norm(raw);

  for (const [slug, name] of Object.entries(table)) {
    if (norm(name) === target || norm(slug) === target) return slug;
  }
  const partial = Object.entries(table).filter(
    ([slug, name]) => norm(name).includes(target) || norm(slug).includes(target),
  );
  if (partial.length === 1) return partial[0]![0];

  const suggestions = (partial.length > 0 ? partial : Object.entries(table))
    .slice(0, 8)
    .map(([slug, name]) => `${name} (${slug})`);

  throw new BackloggdError(
    partial.length > 1
      ? `"${raw}" matches several ${kind}s.`
      : `Unknown ${kind}: "${raw}".`,
    "BAD_INPUT",
    `Did you mean one of: ${suggestions.join(", ")}?`,
  );
}

export const resolvePlatform = (v: string) => resolveSlug(v, PLATFORMS, "platform");
export const resolveGenre = (v: string) => resolveSlug(v, GENRES, "genre");

export function resolveCategory(v: string): string {
  const norm = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((CATEGORIES as readonly string[]).includes(norm)) return norm;
  throw new BackloggdError(
    `Unknown category: "${v}".`,
    "BAD_INPUT",
    `Valid categories: ${CATEGORIES.join(", ")}.`,
  );
}

/**
 * Build a library URL.
 *
 * Shape: `/u/{user}/games/{sort}[:dir]/{key:value;key:value}/` — the sort is its own
 * path segment and the filters are semicolon-joined inside a single following segment.
 */
export function buildLibraryPath(username: string, q: LibraryQuery): string {
  const filters: string[] = [];
  const push = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== "") filters.push(`${k}:${v}`);
  };

  push("type", q.shelf);
  push("game_status", q.completionStatus);
  push("release_platform", q.releasePlatform ? resolvePlatform(q.releasePlatform) : undefined);
  push("played_platform", q.playedPlatform ? resolvePlatform(q.playedPlatform) : undefined);
  push("genre", q.genre ? resolveGenre(q.genre) : undefined);
  push("release_year", q.releaseYear);
  push("played_year", q.playedYear);
  push("category", q.category ? resolveCategory(q.category) : undefined);
  push("categories", q.categories);

  if (q.ratingStars !== undefined) {
    const wire = Math.round(q.ratingStars * 2);
    if (wire < 1 || wire > 10) {
      throw new BackloggdError(
        `Rating filter must be 0.5–5 stars, got ${q.ratingStars}.`,
        "BAD_INPUT",
      );
    }
    push("rating", String(wire));
  }

  // The filter segment is positional: Backloggd reads the first path segment after
  // /games/ as the sort. Emitting filters without one makes it parse "type:backlog;…"
  // as a sort name and return HTTP 500, so a default sort is required whenever any
  // filter is present. A bare /games/ with no segments at all is fine.
  const sort = q.sort ?? (filters.length > 0 ? "added" : undefined);

  // `shuffle` has no meaningful direction, and appending one makes the page 500.
  const sortSegment = sort && sort !== "shuffle" && q.order ? `${sort}:${q.order}` : (sort ?? "");

  const parts = [`/u/${username}/games`];
  if (sortSegment) parts.push(sortSegment);
  if (filters.length > 0) parts.push(filters.join(";"));
  return `${parts.join("/")}/`;
}

/** Build a `/games/lib/…` discovery URL — the same grammar over the whole catalogue. */
export function buildBrowsePath(
  sort: string,
  filters: { genre?: string; releaseYear?: string; releasePlatform?: string; category?: string },
): string {
  const segs: string[] = [];
  const push = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== "") segs.push(`${k}:${v}`);
  };
  push("genre", filters.genre ? resolveGenre(filters.genre) : undefined);
  push("release_year", filters.releaseYear);
  push(
    "release_platform",
    filters.releasePlatform ? resolvePlatform(filters.releasePlatform) : undefined,
  );
  push("category", filters.category ? resolveCategory(filters.category) : undefined);
  return `/games/lib/${sort}/${segs.length > 0 ? `${segs.join(";")}/` : ""}`;
}
