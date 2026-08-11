/** Domain types. These are the shapes tools return — never raw HTML. */

/** Backloggd's four top-level shelves. `none` means "not in the library at all". */
export type LibraryStatus = "played" | "playing" | "backlog" | "wishlist" | "none";

/** Sub-status of a played game, shown as the log's "status" on the site. */
export type PlayedStatus = "played" | "completed" | "retired" | "shelved" | "abandoned";

/**
 * Numeric ids the quick-status modal posts to `PATCH /log/status/`.
 *
 * These are NOT sequential and NOT in menu order — `completed` is 0 and `played` is 5.
 * Read straight off the `status` attributes of `#quick-play-type-modal .play-type-option`
 * on any authenticated game page; do not infer them. Guessing here silently mislabels
 * the user's games (a plausible-looking guess maps "completed" onto "abandoned").
 */
export const PLAYED_STATUS_IDS: Record<PlayedStatus, number> = {
  completed: 0,
  abandoned: 2,
  retired: 3,
  shelved: 4,
  played: 5,
};

/** List kinds accepted by `POST /api/new-list/`. */
export type ListType = "unranked" | "ranked" | "goty";

export interface GameSummary {
  id: number;
  slug: string;
  title: string;
  year: number | null;
  coverUrl: string | null;
  url: string;
}

export interface GameDetail extends GameSummary {
  description: string | null;
  genres: string[];
  platforms: string[];
  developers: string[];
  publishers: string[];
  releaseDate: string | null;
  category: string | null;
  /** Site-wide average, on the 0.5–5 scale shown to users. */
  averageRating: number | null;
  ratingCount: number | null;
  /** Community-tracked playtime in hours. Null fields mean nobody has tracked it. */
  playtime: {
    averageHours: number | null;
    hoursToFinish: number | null;
    hoursToMaster: number | null;
  };
  /** Ratings per half-star bucket, keyed "0.5"…"5". Null when the game has no ratings. */
  ratingDistribution: Record<string, number> | null;
  /** Present only when authenticated. */
  yourEntry?: UserGameEntry | null;
}

/** The caller's own relationship to a game. */
export interface UserGameEntry {
  gameId: number;
  logId: number | null;
  status: LibraryStatus;
  playedStatus: PlayedStatus | null;
  /** 0.5–5 in half-star steps, or null if unrated. */
  rating: number | null;
  liked: boolean;
  isBacklog: boolean;
  isWishlist: boolean;
  isPlaying: boolean;
  isPlayed: boolean;
  hoursPlayed: number | null;
  minutesPlayed: number | null;
}

export interface LibraryEntry {
  game: GameSummary;
  rating: number | null;
  status: LibraryStatus;
  liked: boolean;
}

export interface Playthrough {
  id: number;
  title: string | null;
  rating: number | null;
  review: string | null;
  reviewHasSpoilers: boolean;
  platform: string | null;
  startDate: string | null;
  finishDate: string | null;
  hoursPlayed: number | null;
  minutesPlayed: number | null;
  isReplay: boolean;
  isMastered: boolean;
  status: PlayedStatus | null;
  /** Dated play sessions belonging to this playthrough. */
  sessions: import("./parse/sessions.js").PlaySession[];
}

export interface GameLog {
  game: { id: number; slug?: string; title?: string };
  entry: UserGameEntry;
  playthroughs: Playthrough[];
}

export interface Review {
  id: number | null;
  author: string;
  authorUrl: string;
  gameTitle: string | null;
  gameSlug: string | null;
  rating: number | null;
  body: string;
  hasSpoilers: boolean;
  likeCount: number | null;
  date: string | null;
  url: string | null;
}

export interface JournalEntry {
  date: string | null;
  game: GameSummary;
  platform: string | null;
  rating: number | null;
  status: string | null;
}

export interface GameList {
  slug: string;
  name: string;
  url: string;
  gameCount: number | null;
  likeCount: number | null;
  description: string | null;
  isPrivate: boolean;
}

export interface UserProfile {
  username: string;
  url: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  totalGames: number | null;
  gamesThisYear: number | null;
  backlogCount: number | null;
  favorites: GameSummary[];
}

/** Every paginated tool returns this envelope so callers can page predictably. */
export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  /** Only populated when the site actually tells us; usually null. */
  totalPages: number | null;
}

/**
 * Backloggd stores ratings as integers 1–10 (half-stars). Users think in 0.5–5 stars.
 * The conversion lives here so no caller ever handles the wire scale.
 */
export function ratingToStars(wire: number | null | undefined): number | null {
  if (wire === null || wire === undefined || wire <= 0) return null;
  return wire / 2;
}

export function starsToWire(stars: number): number {
  const wire = Math.round(stars * 2);
  if (wire < 1 || wire > 10) {
    throw new RangeError(`Rating must be between 0.5 and 5 stars, got ${stars}.`);
  }
  return wire;
}
