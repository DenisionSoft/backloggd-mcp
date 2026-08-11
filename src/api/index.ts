import { BASE_URL } from "../config.js";
import { BackloggdError, HttpError } from "../errors.js";
import { CACHE_TTL, TtlCache } from "../cache.js";
import type { HttpClient } from "../http/client.js";
import type { SessionManager } from "../auth/session.js";
import { parseGamePage } from "../parse/game-page.js";
import { parseLibraryPage } from "../parse/library.js";
import { parseAutocomplete, parseSearchResults, type SearchResult } from "../parse/search.js";
import { parseListDetail, parseListsPage, type ListDetail } from "../parse/lists.js";
import { parseReviews } from "../parse/reviews.js";
import { parseJournal, parseProfile } from "../parse/profile.js";
import { parseBatchLogs, parseLogEdit } from "../parse/log.js";
import { parseUserLists, type ListMembership } from "../parse/user-lists.js";
import { parseGameGrid, parseCompanyName } from "../parse/grid.js";
import { parseActivity, parseFollowList, parseNotifications, type ActivityItem, type FollowEntry, type Notification } from "../parse/social.js";
import { buildSessionFields, type PlaySession } from "../parse/sessions.js";
import { buildBrowsePath, buildLibraryPath, type LibraryQuery } from "../filters.js";
import {
  PLAYED_STATUS_IDS,
  starsToWire,
  type GameDetail,
  type GameList,
  type GameLog,
  type JournalEntry,
  type LibraryEntry,
  type LibraryStatus,
  type ListType,
  type Page,
  type PlayedStatus,
  type Review,
  type UserGameEntry,
  type UserProfile,
} from "../types.js";

export interface GameRef {
  id: number;
  slug: string;
  title?: string;
}

/**
 * Domain operations against Backloggd. Everything above this layer deals in typed
 * objects; everything below deals in HTTP.
 */
export class BackloggdApi {
  private readonly slugCache = new TtlCache<GameRef>(CACHE_TTL.slugToId);
  private readonly gameCache = new TtlCache<GameDetail>(CACHE_TTL.gameMetadata);
  private readonly stateCache = new TtlCache<GameLog>(CACHE_TTL.userState);
  private readonly listMembershipCache = new TtlCache<ListMembership[]>(CACHE_TTL.userState);

  constructor(
    private readonly http: HttpClient,
    private readonly session: SessionManager,
  ) {}

  // ---------------------------------------------------------------- resolution

  /**
   * Turn whatever the caller gave us — numeric id, slug, or a human title — into a
   * concrete game reference. Titles go through autocomplete, which is the cheapest
   * lookup Backloggd offers.
   */
  async resolveGame(input: string | number): Promise<GameRef> {
    const raw = String(input).trim();
    if (!raw) throw new BackloggdError("No game specified.", "BAD_INPUT");

    const cached = this.slugCache.get(raw.toLowerCase());
    if (cached) return cached;

    // A bare number is an id; we still need the slug for URLs, and the game page
    // redirects id → slug for us.
    if (/^\d+$/.test(raw)) {
      const ref = await this.refFromGamePage(`/games/${raw}/`, Number.parseInt(raw, 10));
      this.slugCache.set(raw.toLowerCase(), ref);
      return ref;
    }

    // A slug-shaped string: try it directly before falling back to search.
    if (/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
      try {
        const ref = await this.refFromGamePage(`/games/${raw}/`);
        this.slugCache.set(raw.toLowerCase(), ref);
        return ref;
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
      }
    }

    const hits = await this.autocomplete(raw);
    const best = hits[0];
    if (!best) {
      throw new BackloggdError(
        `No game on Backloggd matches "${raw}".`,
        "NOT_FOUND",
        "Try the exact title, or the slug from the game's URL.",
      );
    }
    const ref: GameRef = { id: best.id, slug: best.slug, title: best.title };
    this.slugCache.set(raw.toLowerCase(), ref);
    return ref;
  }

  private async refFromGamePage(path: string, knownId?: number): Promise<GameRef> {
    const res = await this.http.fetch(path);
    const slug = /\/games\/([^/?#]+)/.exec(res.url)?.[1] ?? path.split("/")[2] ?? "";
    const game = parseGamePage(res.body, slug);
    if (!game.id && !knownId) {
      throw new BackloggdError(`Could not determine the game id for ${path}.`, "NOT_FOUND");
    }
    return { id: game.id || (knownId as number), slug: game.slug, title: game.title };
  }

  async autocomplete(query: string) {
    const res = await this.http.fetch("/autocomplete.json", { query: { query } });
    return parseAutocomplete(res.body);
  }

  // ---------------------------------------------------------------- reads

  async searchGames(query: string, limit: number): Promise<SearchResult[]> {
    const res = await this.http.fetch("/search/results/", {
      query: { query, type: "games" },
      turboStream: true,
    });
    const results = parseSearchResults(res.body);
    if (results.length > 0) return results.slice(0, limit);

    // The turbo endpoint occasionally returns an empty stream; autocomplete is a
    // lighter-weight fallback that always answers.
    const hits = await this.autocomplete(query);
    return hits.slice(0, limit).map((h) => ({
      id: h.id,
      slug: h.slug,
      title: h.title,
      year: h.year,
      coverUrl: null,
      url: `${BASE_URL}/games/${h.slug}/`,
      platforms: [],
      category: null,
    }));
  }

  async getGame(ref: GameRef): Promise<GameDetail> {
    return this.gameCache.wrap(ref.slug, async () => {
      const res = await this.http.fetch(`/games/${ref.slug}/`);
      return parseGamePage(res.body, ref.slug);
    });
  }

  /** The caller's own state for a game — the compact JSON endpoint. */
  async getGameLog(gameId: number): Promise<GameLog> {
    return this.stateCache.wrap(`log:${gameId}`, async () => {
      const res = await this.http.fetch(`/log/edit/${gameId}`);
      return parseLogEdit(res.body, gameId);
    });
  }

  /** Batch state lookup — one round trip for many games. */
  async getBatchLogs(gameIds: number[]): Promise<Map<number, UserGameEntry>> {
    if (gameIds.length === 0) return new Map();
    const res = await this.http.fetch("/api/user/games/logs", {
      method: "POST",
      form: { "ids[]": gameIds.map(String) },
    });
    return parseBatchLogs(res.body);
  }

  /**
   * Query a user's library with the full filter grammar.
   *
   * Everything goes through `/u/{name}/games/…` rather than the per-shelf paths, because
   * only that route accepts filters.
   */
  async queryLibrary(
    username: string,
    query: LibraryQuery,
    page = 1,
  ): Promise<Page<LibraryEntry>> {
    const path = buildLibraryPath(username, query);
    const res = await this.http.fetch(path, { query: { page: page > 1 ? page : undefined } });
    return parseLibraryPage(res.body, page);
  }

  async getLibrary(
    username: string,
    opts: { page?: number; status?: Exclude<LibraryStatus, "none">; sort?: string },
  ): Promise<Page<LibraryEntry>> {
    return this.queryLibrary(
      username,
      { shelf: opts.status, sort: opts.sort as LibraryQuery["sort"] },
      opts.page ?? 1,
    );
  }

  /**
   * Page a library query to exhaustion.
   *
   * Termination compares game-id sets between pages, because Backloggd re-serves the
   * final page indefinitely for out-of-range page numbers — "the response was non-empty"
   * is not an end condition.
   */
  async exportLibrary(
    username: string,
    query: LibraryQuery,
    maxGames: number,
  ): Promise<{ items: LibraryEntry[]; pagesFetched: number; truncated: boolean }> {
    const items: LibraryEntry[] = [];
    const seen = new Set<number>();
    let previousSignature = "";
    let page = 1;
    let truncated = false;

    for (; page <= 100; page++) {
      const result = await this.queryLibrary(username, query, page);
      if (result.items.length === 0) break;

      const signature = result.items.map((i) => i.game.id).join(",");
      if (signature === previousSignature) break; // last page re-served
      previousSignature = signature;

      for (const item of result.items) {
        if (seen.has(item.game.id)) continue;
        seen.add(item.game.id);
        items.push(item);
        if (items.length >= maxGames) {
          truncated = true;
          break;
        }
      }
      if (truncated || !result.hasMore) break;
    }

    return { items, pagesFetched: Math.min(page, 100), truncated };
  }

  /** A company's catalogue. Cards carry the caller's own shelf state inline. */
  async browseCompany(
    slug: string,
    sort: string | undefined,
    page: number,
  ): Promise<{ company: string | null } & Page<LibraryEntry>> {
    const path = `/company/${slug}/${sort ? `${sort}/` : ""}`;
    const res = await this.http.fetch(path, { query: { page: page > 1 ? page : undefined } });
    return { company: parseCompanyName(res.body), ...parseGameGrid(res.body, page) };
  }

  /**
   * Related games for one game: series, DLC, editions, mods, bundles.
   *
   * Must use the frame endpoint. The `/games/{slug}/{section}/` page a browser navigates
   * to returns a lazy shell full of placeholder cards — parsing that yields nothing.
   */
  async getRelatedGames(
    gameId: number,
    section: "series" | "dlc" | "editions" | "mods" | "in-bundle" | "related/associated",
  ): Promise<LibraryEntry[]> {
    const res = await this.http.fetch(`/update_game_detail/${gameId}/${section}/`);
    return parseGameGrid(res.body, 1).items;
  }

  async getJournal(username: string, page = 1): Promise<Page<JournalEntry>> {
    const res = await this.http.fetch(`/u/${username}/journal/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseJournal(res.body, page);
  }

  async getLists(username: string, page = 1, sort = "recent"): Promise<Page<GameList>> {
    const res = await this.http.fetch(`/u/${username}/lists/${sort}/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseListsPage(res.body, page);
  }

  async getList(username: string, slug: string, page = 1): Promise<ListDetail> {
    const res = await this.http.fetch(`/u/${username}/list/${slug}/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseListDetail(res.body, username, slug, page);
  }

  async getGameReviews(slug: string, page = 1): Promise<Page<Review>> {
    const res = await this.http.fetch(`/reviews/preview/${slug}/`, {
      query: { page: page > 1 ? page : undefined },
      turboStream: true,
    });
    return parseReviews(res.body, page);
  }

  async getUserReviews(username: string, page = 1): Promise<Page<Review>> {
    const res = await this.http.fetch(`/u/${username}/reviews/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseReviews(res.body, page);
  }

  /**
   * Which of the caller's lists contain this game — one request, all lists.
   *
   * Uses the "add to list" modal rather than walking every list's pages, which for a
   * user with a dozen lists would be dozens of requests per game.
   */
  async getGameListMembership(gameId: number): Promise<ListMembership[]> {
    return this.listMembershipCache.wrap(`lists:${gameId}`, async () => {
      const res = await this.http.fetch("/render/user_lists", { query: { game_id: gameId } });
      return parseUserLists(res.body);
    });
  }

  /** Friends' / your own / inbound activity feed. */
  async getActivity(
    username: string,
    scope: "friends" | "you" | "inbound",
    page = 1,
  ): Promise<Page<ActivityItem>> {
    const res = await this.http.fetch(`/u/${username}/activity/${scope}/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseActivity(res.body, page);
  }

  /** Who a user follows, or who follows them. Yields the numeric ids follows need. */
  async getFollows(
    username: string,
    direction: "following" | "followers",
    page = 1,
  ): Promise<Page<FollowEntry>> {
    const res = await this.http.fetch(`/u/${username}/${direction}/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseFollowList(res.body, page);
  }

  async getNotifications(): Promise<{ items: Notification[]; empty: boolean }> {
    const res = await this.http.fetch("/notifications/");
    return parseNotifications(res.body);
  }

  /** Community logs for a game, optionally friends-only or filtered by rating. */
  async getGameLogs(
    slug: string,
    opts: { friendsOnly?: boolean; ratingStars?: number; page?: number },
  ): Promise<Page<Review>> {
    const filters: string[] = [];
    if (opts.friendsOnly) filters.push("display:friends");
    if (opts.ratingStars !== undefined) filters.push(`rating:${Math.round(opts.ratingStars * 2)}`);
    const seg = filters.length > 0 ? `${filters.join(";")};/` : "";
    const res = await this.http.fetch(`/logs/${slug}/plays/${seg}`, {
      query: { page: opts.page && opts.page > 1 ? opts.page : undefined },
    });
    return parseReviews(res.body, opts.page ?? 1);
  }

  /** A user's own log history for one game (every replay). */
  async getUserGameLogs(username: string, slug: string, page = 1): Promise<Page<Review>> {
    const res = await this.http.fetch(`/u/${username}/logs/${slug}/`, {
      query: { page: page > 1 ? page : undefined },
    });
    return parseReviews(res.body, page);
  }

  async searchUsers(query: string): Promise<{ username: string; url: string }[]> {
    const res = await this.http.fetch("/search/results/", {
      query: { query, type: "users" },
      turboStream: true,
    });
    const names = new Set<string>();
    for (const m of res.body.matchAll(/href="\/u\/([^/?#"]+)\/"/g)) names.add(m[1] as string);
    return [...names].map((username) => ({ username, url: `${BASE_URL}/u/${username}/` }));
  }

  async getProfile(username: string): Promise<UserProfile> {
    const res = await this.http.fetch(`/u/${username}/`);
    return parseProfile(res.body, username);
  }

  async browseGames(
    sort: string,
    page: number,
    filters: Record<string, string | undefined>,
  ): Promise<Page<LibraryEntry>> {
    const path = buildBrowsePath(sort, filters);
    const res = await this.http.fetch(path, { query: { page: page > 1 ? page : undefined } });
    return parseGameGrid(res.body, page);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Set a shelf.
   *
   * `POST /log/` is a *toggle*, not a setter: posting `type=backlog` for a game already
   * on the backlog removes it. So we always read current state first and only send the
   * toggles that actually need to change. Getting this wrong would silently delete the
   * user's entries, which is exactly the class of bug this server must not have.
   */
  async setStatus(gameId: number, target: LibraryStatus): Promise<UserGameEntry> {
    const current = (await this.getGameLog(gameId)).entry;

    const desired = {
      play: target === "played",
      playing: target === "playing",
      backlog: target === "backlog",
      wishlist: target === "wishlist",
    };
    const actual = {
      play: current.isPlayed,
      playing: current.isPlaying,
      backlog: current.isBacklog,
      wishlist: current.isWishlist,
    };

    for (const key of ["play", "playing", "backlog", "wishlist"] as const) {
      if (desired[key] !== actual[key]) {
        await this.http.fetch("/log/", {
          method: "POST",
          write: true,
          form: { type: key, game_id: gameId },
        });
      }
    }

    this.invalidate(gameId);
    return (await this.getGameLog(gameId)).entry;
  }

  /** Set the sub-status of a played game (completed, retired, shelved, abandoned). */
  async setPlayedStatus(gameId: number, status: PlayedStatus): Promise<UserGameEntry> {
    await this.http.fetch("/log/status/", {
      method: "PATCH",
      write: true,
      form: { game_id: gameId, status_id: PLAYED_STATUS_IDS[status] },
    });
    this.invalidate(gameId);
    return (await this.getGameLog(gameId)).entry;
  }

  /** `stars` is on the 0.5-5 user scale; conversion to the 1-10 wire scale happens here. */
  async rateGame(gameId: number, stars: number): Promise<UserGameEntry> {
    await this.http.fetch(`/rate/${gameId}`, {
      method: "POST",
      write: true,
      form: { rating: starsToWire(stars) },
    });
    this.invalidate(gameId);
    return (await this.getGameLog(gameId)).entry;
  }

  async removeRating(gameId: number, logId: number): Promise<UserGameEntry> {
    await this.http.fetch(`/delete-rating/${logId}`, { method: "DELETE", write: true });
    this.invalidate(gameId);
    return (await this.getGameLog(gameId)).entry;
  }

  async setLike(gameId: number, liked: boolean): Promise<UserGameEntry> {
    await this.http.fetch(liked ? `/like/game/${gameId}` : `/unlike/game/${gameId}`, {
      method: liked ? "POST" : "DELETE",
      write: true,
    });
    this.invalidate(gameId);
    return (await this.getGameLog(gameId)).entry;
  }

  /**
   * Create or update the full log for a game: rating, review, platform, dates, playtime.
   *
   * The payload shape mirrors what the site's own log editor posts. `playthroughs[0][id]`
   * of -1 means "new log"; passing an existing playthrough id updates that log in place.
   */
  async saveLog(params: {
    gameId: number;
    playthroughId?: number;
    title?: string;
    stars?: number | null;
    review?: string;
    reviewHasSpoilers?: boolean;
    status?: PlayedStatus;
    startDate?: string;
    finishDate?: string;
    hoursPlayed?: number;
    minutesPlayed?: number;
    isReplay?: boolean;
    isMastered?: boolean;
    liked?: boolean;
  }): Promise<GameLog> {
    const identity = await this.session.ensureAuthenticated();
    const current = (await this.getGameLog(params.gameId)).entry;

    const p = "playthroughs[0]";
    const form: Record<string, string | number | boolean | undefined> = {
      game_id: params.gameId,
      [`${p}[id]`]: params.playthroughId ?? -1,
      [`${p}[title]`]: params.title ?? "Log",
      [`${p}[rating]`]: params.stars ? starsToWire(params.stars) : 0,
      [`${p}[review]`]: params.review ?? "",
      [`${p}[review_spoilers]`]: params.reviewHasSpoilers ? "true" : "false",
      [`${p}[platform]`]: "",
      [`${p}[played_platform]`]: "",
      [`${p}[hours_played]`]: params.hoursPlayed ?? "",
      [`${p}[mins_played]`]: params.minutesPlayed ?? "",
      [`${p}[sync_sessions]`]: "false",
      [`${p}[is_master]`]: params.isMastered ? "true" : "false",
      [`${p}[is_replay]`]: params.isReplay ? "true" : "false",
      [`${p}[start_date]`]: params.startDate ?? "",
      [`${p}[finish_date]`]: params.finishDate ?? "",
      [`${p}[edition_id]`]: "",
      [`${p}[medium_id]`]: "",
      [`${p}[storefront_id]`]: "",
      [`${p}[hours_finished]`]: "",
      [`${p}[mins_finished]`]: "",

      // Preserve shelves the caller did not mention, so saving a review can never
      // silently move a game off the backlog.
      "log[game_liked]": String(params.liked ?? current.liked),
      "log[is_play]": String(params.status ? true : current.isPlayed),
      "log[is_playing]": String(current.isPlaying),
      "log[is_backlog]": String(current.isBacklog),
      "log[is_wishlist]": String(current.isWishlist),
      "log[status]": params.status ?? current.playedStatus ?? "played",
      "log[id]": current.logId ?? "",
      "log[override_cover_id]": "",
      "log[total_hours]": params.hoursPlayed ?? "",
      "log[total_minutes]": params.minutesPlayed ?? "",
      "log[time_source]": "1",
      modal_type: "full",
    };

    await this.http.fetch(`/api/user/${identity.userId}/log/${params.gameId}`, {
      method: "POST",
      write: true,
      form,
    });

    this.invalidate(params.gameId);
    return this.getGameLog(params.gameId);
  }

  async deletePlaythrough(gameId: number, playthroughId: number): Promise<void> {
    await this.http.fetch(`/playthrough/${playthroughId}`, { method: "DELETE", write: true });
    this.invalidate(gameId);
  }

  /** Wipe a game from the library entirely. Destructive and irreversible. */
  async unlog(gameId: number, logId: number): Promise<void> {
    await this.http.fetch("/unlog/", {
      method: "DELETE",
      write: true,
      form: { game_id: gameId, log_id: logId },
    });
    this.invalidate(gameId);
  }

  async updateGameLists(
    gameId: number,
    addListIds: number[],
    removeListIds: number[],
  ): Promise<void> {
    await this.http.fetch(`/api/list/quick/${gameId}`, {
      method: "POST",
      write: true,
      form: {
        "to_add_ids[]": addListIds.map(String),
        "to_remove_ids[]": removeListIds.map(String),
      },
    });
    this.invalidate(gameId);
  }

  /**
   * Create a list. The endpoint takes a flat `{type, title, year}` — not the Rails
   * `list[...]` nesting the creation form's own inputs suggest — and answers with the
   * new list's URL.
   */
  async createList(
    title: string,
    type: ListType = "unranked",
    year?: number,
  ): Promise<{ url: string | null }> {
    const res = await this.http.fetch("/api/new-list/", {
      method: "POST",
      write: true,
      form: { type, title, year: year ?? "" },
    });
    try {
      const parsed = JSON.parse(res.body) as { new_url?: string };
      return { url: parsed.new_url ? new URL(parsed.new_url, BASE_URL).toString() : null };
    } catch {
      return { url: null };
    }
  }

  async setFollow(userId: number, follow: boolean): Promise<void> {
    await this.http.fetch(follow ? "/follow/" : "/unfollow/", {
      method: follow ? "POST" : "DELETE",
      write: true,
      form: { user_id: userId },
    });
  }

  async likeReview(reviewId: number, liked: boolean): Promise<void> {
    await this.http.fetch(
      liked ? `/like/review/${reviewId}` : `/unlike/review/${reviewId}`,
      { method: liked ? "POST" : "DELETE", write: true },
    );
  }

  /**
   * Add or update dated play sessions on a playthrough.
   *
   * Sessions ride along with a normal log save — there is no standalone endpoint — so
   * this re-sends the playthrough with a populated `dates{}` map. Existing shelf state
   * is preserved by `saveLog`.
   */
  async savePlaySessions(
    gameId: number,
    playthroughId: number,
    sessions: {
      id: number;
      startDate: string;
      endDate?: string;
      hours?: number;
      minutes?: number;
      note?: string;
      status?: PlayedStatus;
    }[],
  ): Promise<GameLog> {
    const identity = await this.session.ensureAuthenticated();
    const current = (await this.getGameLog(gameId)).entry;

    const p = "playthroughs[0]";
    const form: Record<string, string | number | boolean | undefined> = {
      game_id: gameId,
      [`${p}[id]`]: playthroughId,
      [`${p}[title]`]: "Log",
      [`${p}[rating]`]: current.rating ? starsToWire(current.rating) : 0,
      [`${p}[review]`]: "",
      [`${p}[review_spoilers]`]: "false",
      [`${p}[sync_sessions]`]: "true",
      [`${p}[is_master]`]: "false",
      [`${p}[is_replay]`]: "false",
      "log[game_liked]": String(current.liked),
      "log[is_play]": String(current.isPlayed),
      "log[is_playing]": String(current.isPlaying),
      "log[is_backlog]": String(current.isBacklog),
      "log[is_wishlist]": String(current.isWishlist),
      "log[status]": current.playedStatus ?? "played",
      "log[id]": current.logId ?? "",
      "log[time_source]": "1",
      modal_type: "full",
      ...buildSessionFields(playthroughId, sessions),
    };

    await this.http.fetch(`/api/user/${identity.userId}/log/${gameId}`, {
      method: "POST",
      write: true,
      form,
    });
    this.invalidate(gameId);
    return this.getGameLog(gameId);
  }

  /** Reorder / renote list entries. `entries` must be the full ordered set. */
  async updateListEntries(
    listId: number,
    entries: { entryId: number; position: number; note?: string }[],
  ): Promise<void> {
    const payload = {
      entries: entries.map((e) => ({
        entry_id: e.entryId,
        position: e.position,
        note: e.note ?? "",
      })),
    };
    await this.http.fetch(`/api/list/${listId}/update-entries-2/`, {
      method: "PUT",
      write: true,
      headers: { "Content-Type": "application/json" },
      json: payload,
    });
  }

  async deleteList(listId: number): Promise<void> {
    await this.http.fetch(`/api/list/${listId}`, { method: "DELETE", write: true });
  }

  async addFavorite(gameId: number): Promise<void> {
    await this.http.fetch(`/add-favorite/${gameId}/`, { method: "POST", write: true });
  }

  async saveReviewDraft(review: string): Promise<void> {
    await this.http.fetch("/user/review/draft", {
      method: "POST",
      write: true,
      form: { review },
    });
  }

  async postComment(
    model: "review" | "list",
    modelId: number,
    body: string,
  ): Promise<void> {
    await this.http.fetch("/comment/", {
      method: "POST",
      write: true,
      form: { commentable_type: model, commentable_id: modelId, body },
    });
  }

  async deleteComment(commentId: number): Promise<void> {
    await this.http.fetch(`/comment/destroy/${commentId}`, { method: "DELETE", write: true });
  }

  /** Drop cached state for a game after mutating it, so the next read is truthful. */
  private invalidate(gameId: number): void {
    this.stateCache.delete(`log:${gameId}`);
    this.listMembershipCache.delete(`lists:${gameId}`);
  }
}
