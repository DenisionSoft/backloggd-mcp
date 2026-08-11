import { z } from "zod";
import { defineTool, type AnyToolDef } from "./types.js";
import type { GameRef } from "../api/index.js";
import { GENRES, PLATFORMS } from "../vocab.js";
import { LIBRARY_SORTS } from "../filters.js";
import type { LibraryQuery } from "../filters.js";
import { DeadlineError } from "../errors.js";

const gameArg = z
  .string()
  .describe(
    "Game title, slug, or numeric Backloggd id. Titles are resolved via search, so " +
      "'elden ring', 'elden-ring' and '119133' all work.",
  );

const pageArg = z.number().int().min(1).max(500).default(1).describe("1-based page number.");

const usernameArg = z
  .string()
  .optional()
  .describe("Backloggd username. Defaults to the authenticated user.");

async function resolveUsername(
  supplied: string | undefined,
  ctx: { session: { ensureAuthenticated: () => Promise<{ username: string }> } },
): Promise<string> {
  if (supplied) return supplied;
  return (await ctx.session.ensureAuthenticated()).username;
}

export const readTools: AnyToolDef[] = [
  defineTool({
    name: "backloggd_whoami",
    title: "Who am I",
    description:
      "Report the authenticated Backloggd account, whether writes are enabled, and the " +
      "current rate-limit state. Use this first if you are unsure the server is set up.",
    inputSchema: {},
    async handler(_args, ctx) {
      const identity = await ctx.session.ensureAuthenticated();
      return {
        username: identity.username,
        userId: identity.userId,
        profileUrl: `https://backloggd.com/u/${identity.username}/`,
        writesEnabled: !ctx.config.readOnly,
        authMode: ctx.config.authMode,
        rateLimit: ctx.http.rateLimitStatus(),
      };
    },
  }),

  defineTool({
    name: "search_games",
    title: "Search games",
    description:
      "Search Backloggd's game catalogue by title. Returns id, slug, year, platforms and " +
      "category. Set include_my_status to also report your own rating and shelf for each " +
      "hit, which costs one extra request for the whole result set.",
    inputSchema: {
      query: z.string().min(1).describe("Search text, e.g. 'hollow knight'."),
      limit: z.number().int().min(1).max(50).default(10),
      include_my_status: z
        .boolean()
        .default(false)
        .describe("Annotate each result with your rating, shelf and like state."),
    },
    async handler(args, ctx) {
      const query = args["query"] as string;
      const limit = args["limit"] as number;
      const includeStatus = args["include_my_status"] as boolean;

      const results = await ctx.api.searchGames(query, limit);
      if (!includeStatus || results.length === 0) return { results };

      const states = await ctx.api.getBatchLogs(results.map((r) => r.id));
      return {
        results: results.map((r) => {
          const s = states.get(r.id);
          return {
            ...r,
            yourStatus: s?.status ?? "none",
            yourRating: s?.rating ?? null,
            youLiked: s?.liked ?? false,
          };
        }),
      };
    },
  }),

  defineTool({
    name: "get_game",
    title: "Get game details",
    description:
      "Full metadata for one game — description, genres, platforms, developers, release " +
      "date, community playtime, the rating histogram and the site-wide average — plus " +
      "your own log entry for it. parentGameSlug is set when the game is add-on content " +
      "(DLC, an expansion, an edition) and names what it belongs to. For the precise " +
      "category label (Main Game / DLC / Expansion / Bundle) use search_games, which is " +
      "the only place Backloggd prints it.",
    inputSchema: {
      game: gameArg,
      include_my_log: z
        .boolean()
        .default(true)
        .describe("Include your rating, shelf, playthroughs and review for this game."),
    },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const game = await ctx.api.getGame(ref);
      if (!(args["include_my_log"] as boolean)) return game;

      const log = await ctx.api.getGameLog(ref.id);
      return { ...game, yourEntry: log.entry, yourPlaythroughs: log.playthroughs };
    },
  }),

  defineTool({
    name: "get_my_game_log",
    title: "Get your log for a game",
    description:
      "Your complete log for one game: shelf, rating, like state, playtime, and every " +
      "playthrough with its review and dates.",
    inputSchema: { game: gameArg },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const log = await ctx.api.getGameLog(ref.id);
      return { game: { ...ref }, entry: log.entry, playthroughs: log.playthroughs };
    },
  }),

  defineTool({
    name: "check_games",
    title: "Check a batch of games against your account",
    description:
      "Given a list of game names, report where each one sits in your Backloggd: its shelf " +
      "(played / playing / backlog / wishlist / none), completion status, your rating, and " +
      "optionally which of your custom lists contain it. Built for questions like 'here " +
      "are 20 games, which do I already have?'. Names that match no game are reported as " +
      "not_found rather than failing the batch.\n\n" +
      "Cost: one request per name to resolve it, plus one shared request for all the " +
      "shelf states. include_lists adds list membership; for a large batch it pages your " +
      "lists once and inverts them rather than asking per game, so it stays affordable.\n\n" +
      "The call has a wall-clock budget and stops early rather than exceeding the " +
      "client's tool-call timeout. When that happens `summary.incomplete` is true and " +
      "`summary.notAttempted` lists the names it did not reach; `summary.listsPartial` " +
      "means list membership is under-reported and absence of a list does not prove " +
      "absence. Either way, just call again with the remaining names — resolved games " +
      "and the list index are both cached, so follow-up calls are much faster. For 40+ " +
      "games expect to make two or three calls.",
    inputSchema: {
      games: z
        .array(z.string().min(1))
        .min(1)
        .max(40)
        .describe("Game names, slugs or ids. Up to 40 per call."),
      include_lists: z
        .boolean()
        .default(false)
        .describe(
          "Also report which of your custom lists contain each game. Off by default " +
            "because it costs an extra request per game and roughly doubles the runtime; " +
            "shelf, rating and like state come back either way. Turn it on when the " +
            "question is actually about lists, and prefer batches of ~10.",
        ),
    },
    async handler(args, ctx) {
      const names = args["games"] as string[];
      const includeLists = args["include_lists"] as boolean;

      // Stop before the MCP client's tool-call timeout rather than blowing through it.
      // Exceeding it loses the entire result; stopping early loses only the tail, and
      // the caller can ask for the rest.
      const deadline = Date.now() + ctx.config.batchBudgetMs;

      // Resolve first: shelf state is the primary answer, and a truncated resolution is
      // a clean failure (the untried names come back in notAttempted). Lists are the
      // expensive extra and take whatever budget is left.
      const resolved: { query: string; ref: GameRef | null; error?: string }[] = [];
      const notAttempted: string[] = [];
      for (const name of names) {
        if (Date.now() > deadline) {
          notAttempted.push(name);
          continue;
        }
        try {
          resolved.push({
            query: name,
            ref: await ctx.http.withDeadline(deadline, () => ctx.api.resolveGame(name)),
          });
        } catch (err) {
          // Out of time is not a failed lookup — the name simply never got tried.
          if (err instanceof DeadlineError) {
            notAttempted.push(name);
            continue;
          }
          resolved.push({
            query: name,
            ref: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const found = resolved.filter((r) => r.ref !== null);
      const states = await ctx.http
        .withDeadline(deadline, () => ctx.api.getBatchLogs(found.map((r) => r.ref!.id)))
        .catch(() => new Map());

      const username = (await ctx.http.withDeadline(deadline, () =>
        ctx.session.ensureAuthenticated(),
      )).username;

      let listIndex: Map<number, { id: number; name: string; url: string | null }[]> | null = null;
      let listsPartial = false;
      let useIndex = false;
      if (includeLists) {
        try {
          const listCount = (
            await ctx.http.withDeadline(deadline, () => ctx.api.getLists(username, 1))
          ).items.length;
          useIndex = found.length > listCount;
          if (useIndex) {
            const built = await ctx.http.withDeadline(deadline, () =>
              ctx.api.getListMembershipIndex(username, deadline),
            );
            listIndex = built.index;
            listsPartial = !built.complete;
          }
        } catch {
          listsPartial = true;
        }
      }

      /*
       * Two ways to learn list membership, with very different costs:
       *
       *  - per game: one request each, so 100 games is 100 requests;
       *  - reverse index: page every list once and invert it, so the cost tracks the
       *    number of lists and is flat in the number of games.
       *
       * The index wins as soon as there are more games than list pages, which for a
       * typical account is around a dozen. Below that the per-game path avoids paying
       * for lists the caller never asked about.
       */
      interface CheckResult {
        query: string;
        found: boolean;
        reason?: string;
        title?: string;
        /** Omitted when resolution did not yield a year — never nulled. */
        year?: number;
        url?: string;
        status?: string;
        playedStatus?: string | null;
        rating?: number | null;
        liked?: boolean;
        lists?: { id: number; name: string; url: string | null }[];
        untracked?: boolean;
      }

      const results: CheckResult[] = [];
      for (const item of resolved) {
        if (!item.ref) {
          results.push({ query: item.query, found: false, reason: item.error });
          continue;
        }
        const state = states.get(item.ref.id);

        let lists: { id: number; name: string; url: string | null }[] | undefined;
        if (listIndex) {
          lists = listIndex.get(item.ref.id) ?? [];
        } else if (includeLists && Date.now() <= deadline) {
          try {
            lists = (
              await ctx.http.withDeadline(deadline, () =>
                ctx.api.getGameListMembership(item.ref!.id),
              )
            )
              .filter((l) => l.contains)
              .map((l) => ({ id: l.listId, name: l.name, url: l.url }));
          } catch {
            listsPartial = true;
          }
        } else if (includeLists) {
          listsPartial = true;
        }

        results.push({
          query: item.query,
          found: true,
          title: item.ref.title ?? item.ref.slug,
          // Present when resolution went through autocomplete or a game page; omitted
          // rather than nulled when the lookup did not yield one.
          ...(item.ref.year != null ? { year: item.ref.year } : {}),
          url: `https://backloggd.com/games/${item.ref.slug}/`,
          status: state?.status ?? "none",
          playedStatus: state?.playedStatus ?? null,
          rating: state?.rating ?? null,
          liked: state?.liked ?? false,
          lists,
          // True when the game is on no shelf and in no list at all.
          untracked:
            (state?.status ?? "none") === "none" && (lists === undefined || lists.length === 0),
        });
      }

      const tracked = results.filter((r) => r.found && !r.untracked).length;
      return {
        results,
        summary: {
          requested: names.length,
          matched: found.length,
          notFound: resolved.length - found.length,
          tracked,
          untracked: found.length - tracked,
          listsChecked: includeLists,
          // The index ran out of time, so list membership is under-reported: a game
          // shown with no lists might be in one of the lists that was never scanned.
          ...(listsPartial
            ? {
                listsPartial: true,
                listsNote:
                  "Ran out of time while scanning your lists, so list membership is " +
                  "incomplete — absence of a list here does not prove absence. Retry " +
                  "with a smaller batch, or raise BACKLOGGD_BATCH_BUDGET_MS.",
              }
            : {}),
          // Non-empty only when the time budget ran out. Call again with just these.
          ...(notAttempted.length > 0
            ? {
                incomplete: true,
                notAttempted,
                note:
                  `Stopped after ${ctx.config.batchBudgetMs / 1000}s to stay inside the ` +
                  `client's tool-call timeout. ${notAttempted.length} name(s) were not ` +
                  `checked — call again with just those. Resolved games are cached, so ` +
                  `the retry is faster.`,
              }
            : {}),
        },
      };
    },
  }),

  defineTool({
    name: "get_game_lists",
    title: "Which of your lists contain a game",
    description:
      "Report every one of your custom lists and whether it contains this game. Returns the " +
      "list ids needed by add_game_to_lists.",
    inputSchema: {
      game: gameArg,
      only_containing: z
        .boolean()
        .default(false)
        .describe("Return only the lists that already contain the game."),
    },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const all = await ctx.api.getGameListMembership(ref.id);
      const lists = (args["only_containing"] as boolean) ? all.filter((l) => l.contains) : all;
      return { game: ref, inLists: all.filter((l) => l.contains).map((l) => l.name), lists };
    },
  }),

  defineTool({
    name: "query_library",
    title: "Query a game library",
    description:
      "Search a user's library with Backloggd's full filter grammar. Defaults to your own. " +
      "This is the main discovery tool: combine a shelf with a release platform, genre, " +
      "year, completion status or rating, and sort by anything including how long games " +
      "take to finish.\n\n" +
      "Examples: shelf='backlog' + release_platform='PS5' answers 'what do I have that " +
      "runs on PS5'; sort='shuffle' picks at random; sort='avg-finish-time' ranks by how " +
      "long games take (LONGEST first by default — see the sort notes).\n\n" +
      "An empty result means nothing matched — invalid filter values are rejected before " +
      "the request is sent, so a zero-row answer is trustworthy.\n\n" +
      "Rows carry id, slug, title, cover and your own shelf/rating only. Backloggd's grid " +
      "markup has no release year, platforms or genres, so those keys are absent rather " +
      "than null — use get_games_metadata to fill them in for a shortlist.",
    inputSchema: {
      username: usernameArg,
      shelf: z
        .enum(["played", "playing", "backlog", "wishlist"])
        .optional()
        .describe("Which shelf to restrict to."),
      completion_status: z
        .enum(["played", "completed", "retired", "shelved", "abandoned"])
        .optional(),
      release_platform: z
        .string()
        .optional()
        .describe(
          "Platform the game RELEASED on, by name or slug ('PS5', 'Wii U', 'Meta Quest 3'). " +
            "This is the one you want for backlog questions.",
        ),
      played_platform: z
        .string()
        .optional()
        .describe(
          "Platform YOU played it on. Empty for unplayed games, so it returns nothing on a " +
            "backlog — use release_platform instead unless you specifically mean this.",
        ),
      genre: z.string().optional().describe("Genre by name or slug, e.g. 'Simulator', 'RPG'."),
      release_year: z
        .string()
        .optional()
        .describe("Four-digit year, or 'upcoming' / 'released'."),
      played_year: z.string().optional().describe("Four-digit year you played it."),
      rating: z.number().min(0.5).max(5).optional().describe("Your rating, 0.5-5 stars."),
      category: z
        .string()
        .optional()
        .describe("Game category, e.g. 'main_game', 'dlc', 'remake'."),
      categories: z
        .enum(["games", "extras", "all"])
        .optional()
        .describe("'games' excludes DLC and other extras."),
      sort: z.enum(LIBRARY_SORTS as [string, ...string[]]).optional()
        .describe(
          "shuffle = random pick; user-rating = your score; rating = community score. " +
            "avg-finish-time / avg-play-time rank by community playtime and default to " +
            "LONGEST first. Do NOT use order='asc' to find short games: ascending puts " +
            "games with NO recorded finish time first (MMOs, live-service and obscure " +
            "titles), not genuinely short ones. To actually find short games, take an " +
            "ascending page and check real hours with get_games_metadata.",
        ),
      order: z.enum(["asc", "desc"]).optional(),
      page: pageArg,
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      const query: LibraryQuery = {
        shelf: args["shelf"] as LibraryQuery["shelf"],
        completionStatus: args["completion_status"] as LibraryQuery["completionStatus"],
        releasePlatform: args["release_platform"] as string | undefined,
        playedPlatform: args["played_platform"] as string | undefined,
        genre: args["genre"] as string | undefined,
        releaseYear: args["release_year"] as string | undefined,
        playedYear: args["played_year"] as string | undefined,
        ratingStars: args["rating"] as number | undefined,
        category: args["category"] as string | undefined,
        categories: args["categories"] as LibraryQuery["categories"],
        sort: args["sort"] as LibraryQuery["sort"],
        order: args["order"] as "asc" | "desc" | undefined,
      };
      return ctx.api.queryLibrary(username, query, args["page"] as number);
    },
  }),

  defineTool({
    name: "export_library",
    title: "Export a whole library",
    description:
      "Page a library query to exhaustion and return a compact list of every match. Use " +
      "when you need to reason over the entire set — 'which of my backlog are space sims', " +
      "'which are good co-op games' — rather than a single page. Narrow with filters first " +
      "where you can: a genre filter can turn nine requests into one. Reports how many " +
      "pages were fetched and whether the cap truncated the result.",
    inputSchema: {
      username: usernameArg,
      shelf: z.enum(["played", "playing", "backlog", "wishlist"]).optional(),
      release_platform: z.string().optional(),
      genre: z.string().optional(),
      release_year: z.string().optional(),
      completion_status: z
        .enum(["played", "completed", "retired", "shelved", "abandoned"])
        .optional(),
      max_games: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(500)
        .describe("Safety cap. Each 40 games costs one request."),
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      const deadline = Date.now() + ctx.config.batchBudgetMs;
      const result = await ctx.http.withDeadline(deadline, () =>
        ctx.api.exportLibrary(
          username,
          {
            shelf: args["shelf"] as LibraryQuery["shelf"],
            releasePlatform: args["release_platform"] as string | undefined,
            genre: args["genre"] as string | undefined,
            releaseYear: args["release_year"] as string | undefined,
            completionStatus: args["completion_status"] as LibraryQuery["completionStatus"],
          },
          args["max_games"] as number,
        ),
      );
      return {
        games: result.items.map((i) => ({
          id: i.game.id,
          title: i.game.title,
          slug: i.game.slug,
          status: i.status,
          rating: i.rating,
        })),
        count: result.items.length,
        pagesFetched: result.pagesFetched,
        truncated: result.truncated,
      };
    },
  }),

  defineTool({
    name: "browse_games",
    title: "Browse the catalogue",
    description:
      "Discover games by sort order and filters rather than by title — 'popular RPGs from " +
      "2022', 'highest rated on Switch'. Filters use Backloggd's own slugs.",
    inputSchema: {
      sort: z
        .enum(["popular", "rating", "release", "trending", "title", "time-played"])
        .default("popular"),
      genre: z.string().optional().describe("Genre slug, e.g. 'role-playing-rpg', 'shooter'."),
      release_year: z.string().optional().describe("Four-digit year, e.g. '2022'."),
      release_platform: z.string().optional().describe("Platform slug, e.g. 'win', 'switch'."),
      page: pageArg,
    },
    async handler(args, ctx) {
      return ctx.api.browseGames(args["sort"] as string, args["page"] as number, {
        genre: args["genre"] as string | undefined,
        release_year: args["release_year"] as string | undefined,
        release_platform: args["release_platform"] as string | undefined,
      });
    },
  }),

  defineTool({
    name: "get_journal",
    title: "Get play journal",
    description:
      "A user's chronological play journal — what they played, when, on which platform.",
    inputSchema: { username: usernameArg, page: pageArg },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getJournal(username, args["page"] as number);
    },
  }),

  defineTool({
    name: "get_lists",
    title: "Get a user's lists",
    description: "The lists a user has created, with game counts.",
    inputSchema: {
      username: usernameArg,
      sort: z.enum(["recent", "created", "likes", "title"]).default("recent"),
      page: pageArg,
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getLists(username, args["page"] as number, args["sort"] as string);
    },
  }),

  defineTool({
    name: "get_list",
    title: "Get one list's games",
    description: "The games in a single list, paginated.",
    inputSchema: {
      list_slug: z.string().describe("List slug from its URL, e.g. 'favourite-rpgs'."),
      username: usernameArg,
      page: pageArg,
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getList(username, args["list_slug"] as string, args["page"] as number);
    },
  }),

  defineTool({
    name: "get_game_reviews",
    title: "Get reviews of a game",
    description: "Community reviews for a game, with ratings, authors and like counts.",
    inputSchema: { game: gameArg, page: pageArg },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      return ctx.api.getGameReviews(ref.slug, args["page"] as number);
    },
  }),

  defineTool({
    name: "get_user_reviews",
    title: "Get a user's reviews",
    description: "Reviews written by a user. Defaults to your own.",
    inputSchema: { username: usernameArg, page: pageArg },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getUserReviews(username, args["page"] as number);
    },
  }),

  defineTool({
    name: "get_user_profile",
    title: "Get a user profile",
    description:
      "A user's public profile: bio, favourite games, and counts of games played and backlogged.",
    inputSchema: { username: usernameArg },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getProfile(username);
    },
  }),

  defineTool({
    name: "browse_company",
    title: "Browse a company's games",
    description:
      "Every game by a developer or publisher, with YOUR shelf and rating attached to each " +
      "one — 60 per request, no follow-up lookups. Rows carry no year or platforms (grid " +
      "markup has neither); enrich a shortlist with get_games_metadata if you need them. Good for 'which FromSoftware games " +
      "haven't I played' and for franchise gap-hunting: browse the publisher, then look for " +
      "the entries you don't have. Company slugs come from get_game's developers field or " +
      "the company links on a game page.",
    inputSchema: {
      company: z.string().describe("Company slug, e.g. 'fromsoftware', 'activision'."),
      sort: z
        .enum(["popular", "rating", "release", "title", "time-played", "time-finished"])
        .default("release"),
      order: z.enum(["asc", "desc"]).optional(),
      page: pageArg,
    },
    async handler(args, ctx) {
      const sort = args["sort"] as string;
      const order = args["order"] as string | undefined;
      return ctx.api.browseCompany(
        args["company"] as string,
        order ? `${sort}:${order}` : sort,
        args["page"] as number,
      );
    },
  }),

  defineTool({
    name: "get_related_games",
    title: "Series, DLC and editions of a game",
    description:
      "Games related to one game — its series, DLC, editions, mods or bundles — each with " +
      "your own shelf state attached.\n\n" +
      "NEVER use this to conclude you are missing something. It is a partial preview, and " +
      "measured against a real library it gives false negatives:\n" +
      "- 'series' returns AT MOST 6 entries. Doom, Donkey Kong, Mario Kart, Shinobi and " +
      "Call of Duty all return exactly 6, which is the cap, not the franchise.\n" +
      "- 'series' also follows IGDB's collection grouping, so Modern Warfare and Black Ops " +
      "are not in Call of Duty's series.\n" +
      "- 'editions' is incomplete: Ghost of Tsushima's editions omit the Director's Cut.\n" +
      "- Editions and remasters are SEPARATE entries, so a franchise can look untracked " +
      "while you own it under another entry (Mario Kart 8 Deluxe, not Mario Kart 8).\n\n" +
      "Use it to surface obscure entries you would not have thought of. For 'what am I " +
      "missing in this franchise', name the titles from your own knowledge or the web and " +
      "pass them to check_games, which is authoritative and costs one request for the whole " +
      "batch. To ask what a game is an edition OF, get_game's parentGameSlug is reliable — " +
      "that direction of the link works even where this tool's does not.",
    inputSchema: {
      game: gameArg,
      section: z
        .enum(["series", "dlc", "editions", "mods", "in-bundle", "related/associated"])
        .default("series"),
    },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const games = await ctx.api.getRelatedGames(
        ref.id,
        args["section"] as "series" | "dlc" | "editions" | "mods" | "in-bundle" | "related/associated",
      );
      return { game: ref, section: args["section"], count: games.length, games };
    },
  }),

  defineTool({
    name: "get_games_metadata",
    title: "Metadata for several games at once",
    description:
      "Platforms, genres, year, rating and playtime for a set of games. COSTS ONE REQUEST " +
      "PER GAME, so keep batches small and prefer query_library when the set is really a " +
      "library query (that is one request for the whole page). Use this for sets that are " +
      "not a library query — most often the contents of a custom list, e.g. 'which of my VR " +
      "list are on Quest 3'. Results are cached for six hours, so follow-up questions over " +
      "the same games are nearly free.",
    inputSchema: {
      games: z.array(z.string().min(1)).min(1).max(25).describe("Up to 25 names, slugs or ids."),
      include_playtime: z.boolean().default(true),
    },
    async handler(args, ctx) {
      const names = args["games"] as string[];
      const withPlaytime = args["include_playtime"] as boolean;
      const deadline = Date.now() + ctx.config.batchBudgetMs;
      const results = [];
      const notAttempted: string[] = [];
      for (const name of names) {
        if (Date.now() > deadline) {
          notAttempted.push(name);
          continue;
        }
        try {
          const ref = await ctx.http.withDeadline(deadline, () => ctx.api.resolveGame(name));
          const g = await ctx.http.withDeadline(deadline, () => ctx.api.getGame(ref));
          results.push({
            query: name,
            found: true,
            id: g.id,
            title: g.title,
            slug: g.slug,
            year: g.year,
            platforms: g.platforms,
            genres: g.genres,
            developers: g.developers,
            averageRating: g.averageRating,
            ...(withPlaytime ? { playtime: g.playtime } : {}),
          });
        } catch (err) {
          results.push({
            query: name,
            found: false,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        results,
        requested: names.length,
        requestsUsed: results.length,
        ...(notAttempted.length > 0
          ? {
              incomplete: true,
              notAttempted,
              note: "Ran out of time; call again with just these names (already-fetched games are cached).",
            }
          : {}),
      };
    },
  }),

  defineTool({
    name: "find_in_collection",
    title: "Search everything you've saved",
    description:
      "Find games across your shelves AND all your custom lists at once, annotated with " +
      "where each one came from. Answers questions of the form 'in my backlog or any list, " +
      "which are X'. Needed because list pages do not support filters — the shelf half is " +
      "filtered server-side, the list half is gathered and filtered locally. Costs one " +
      "request per list page plus one per shelf page, so it is heavier than query_library; " +
      "use that instead when you only care about shelves.",
    inputSchema: {
      shelf: z
        .enum(["played", "playing", "backlog", "wishlist"])
        .optional()
        .describe("Restrict the shelf half. Omit to include the whole library."),
      release_platform: z.string().optional(),
      genre: z.string().optional(),
      title_contains: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on the title, applied to both halves."),
      include_lists: z.boolean().default(true),
      max_games: z.number().int().min(1).max(2000).default(600),
    },
    async handler(args, ctx) {
      const deadline = Date.now() + ctx.config.batchBudgetMs;
      const username = (await ctx.session.ensureAuthenticated()).username;
      const platform = args["release_platform"] as string | undefined;
      const genre = args["genre"] as string | undefined;
      const needle = (args["title_contains"] as string | undefined)?.toLowerCase();
      const max = args["max_games"] as number;

      type Hit = {
        id: number;
        title: string;
        slug: string;
        status: string;
        rating: number | null;
        shelves: string[];
        lists: string[];
      };
      const byId = new Map<number, Hit>();

      const shelfResult = await ctx.http.withDeadline(deadline, () =>
        ctx.api.exportLibrary(
          username,
          { shelf: args["shelf"] as never, releasePlatform: platform, genre },
          max,
        ),
      );
      for (const item of shelfResult.items) {
        byId.set(item.game.id, {
          id: item.game.id,
          title: item.game.title,
          slug: item.game.slug,
          status: item.status,
          rating: item.rating,
          shelves: [item.status],
          lists: [],
        });
      }

      let listsScanned = 0;
      let listsComplete = true;
      if (args["include_lists"] as boolean) {
        const lists = await ctx.http.withDeadline(deadline, () => ctx.api.getLists(username, 1));
        for (const list of lists.items) {
          if (Date.now() > deadline) {
            listsComplete = false;
            break;
          }
          listsScanned += 1;
          const detail = await ctx.http.withDeadline(deadline, () =>
            ctx.api.getList(username, list.slug, 1),
          );
          for (const g of detail.games) {
            const existing = byId.get(g.id);
            if (existing) {
              if (!existing.lists.includes(list.name)) existing.lists.push(list.name);
            } else {
              byId.set(g.id, {
                id: g.id,
                title: g.title,
                slug: g.slug,
                status: "none",
                rating: null,
                shelves: [],
                lists: [list.name],
              });
            }
          }
        }
      }

      let hits = [...byId.values()];
      if (needle) hits = hits.filter((h) => h.title.toLowerCase().includes(needle));

      return {
        results: hits.slice(0, max),
        summary: {
          total: hits.length,
          fromShelves: hits.filter((h) => h.shelves.length > 0).length,
          listsScanned,
          ...(listsComplete
            ? {}
            : {
                incomplete: true,
                incompleteNote:
                  "Ran out of time before scanning every list, so this is not the full " +
                  "picture — a game missing here may still be in an unscanned list.",
              }),
          note:
            platform || genre
              ? "Platform/genre filters were applied server-side to shelves only; list-only " +
                "games are unfiltered. Use get_games_metadata to check those."
              : undefined,
        },
      };
    },
  }),

  defineTool({
    name: "get_play_sessions",
    title: "Dated play sessions for a game",
    description:
      "Your dated play sessions for a game — when you played, for how long, and any notes " +
      "or tags. These sit inside each playthrough and are what the journal view is built on.",
    inputSchema: { game: gameArg },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const log = await ctx.api.getGameLog(ref.id);
      return {
        game: ref,
        playthroughs: log.playthroughs.map((p) => ({
          id: p.id,
          title: p.title,
          sessions: p.sessions,
          totalSessions: p.sessions.length,
        })),
      };
    },
  }),

  defineTool({
    name: "get_notifications",
    title: "Your notifications",
    description: "Recent notifications on your account.",
    inputSchema: {},
    async handler(_args, ctx) {
      return ctx.api.getNotifications();
    },
  }),

  defineTool({
    name: "get_activity",
    title: "Activity feed",
    description:
      "Recent activity: what friends have been playing, rating and reviewing ('friends'), " +
      "your own actions ('you'), or things others did to your content ('inbound').",
    inputSchema: {
      scope: z.enum(["friends", "you", "inbound"]).default("friends"),
      username: usernameArg,
      page: pageArg,
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getActivity(
        username,
        args["scope"] as "friends" | "you" | "inbound",
        args["page"] as number,
      );
    },
  }),

  defineTool({
    name: "get_follows",
    title: "Following / followers",
    description:
      "Who a user follows, or who follows them. Returns the numeric user ids that " +
      "set_follow_user needs.",
    inputSchema: {
      direction: z.enum(["following", "followers"]).default("following"),
      username: usernameArg,
      page: pageArg,
    },
    async handler(args, ctx) {
      const username = await resolveUsername(args["username"] as string | undefined, ctx);
      return ctx.api.getFollows(
        username,
        args["direction"] as "following" | "followers",
        args["page"] as number,
      );
    },
  }),

  defineTool({
    name: "get_game_logs",
    title: "Community or personal logs for a game",
    description:
      "Logs of a game by the community, optionally friends-only or filtered by rating. Set " +
      "username to read one person's full log history for that game instead (every replay).",
    inputSchema: {
      game: gameArg,
      username: z
        .string()
        .optional()
        .describe("Read this user's own log history for the game instead of community logs."),
      friends_only: z.boolean().default(false),
      rating: z.number().min(0.5).max(5).optional(),
      page: pageArg,
    },
    async handler(args, ctx) {
      const ref = await ctx.api.resolveGame(args["game"] as string);
      const username = args["username"] as string | undefined;
      if (username) return ctx.api.getUserGameLogs(username, ref.slug, args["page"] as number);
      return ctx.api.getGameLogs(ref.slug, {
        friendsOnly: args["friends_only"] as boolean,
        ratingStars: args["rating"] as number | undefined,
        page: args["page"] as number,
      });
    },
  }),

  defineTool({
    name: "search_users",
    title: "Search for users",
    description: "Find Backloggd users by name. Pair with get_follows to get numeric ids.",
    inputSchema: { query: z.string().min(2) },
    async handler(args, ctx) {
      return { users: await ctx.api.searchUsers(args["query"] as string) };
    },
  }),

  defineTool({
    name: "list_filter_values",
    title: "Valid platform and genre filter values",
    description:
      "The accepted values for platform and genre filters. Useful when a filter was " +
      "rejected, or to check whether a platform exists before querying. Filters accept " +
      "plain names too ('PS5', 'Meta Quest 3') — this is for when you want the exact list.",
    inputSchema: {
      kind: z.enum(["platforms", "genres"]),
      search: z.string().optional().describe("Case-insensitive substring filter on the name."),
    },
    async handler(args) {
      const table = args["kind"] === "genres" ? GENRES : PLATFORMS;
      const needle = (args["search"] as string | undefined)?.toLowerCase();
      const entries = Object.entries(table)
        .filter(([slug, name]) =>
          needle ? name.toLowerCase().includes(needle) || slug.includes(needle) : true,
        )
        .map(([slug, name]) => ({ slug, name }));
      return { kind: args["kind"], count: entries.length, values: entries };
    },
  }),
];
