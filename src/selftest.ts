import type { ToolContext } from "./tools/types.js";

/**
 * Exercise every read parser against the live site.
 *
 * Backloggd's markup will change eventually, and when it does the failure should be one
 * command away from a diagnosis rather than a confusing empty result inside a chat.
 * This runs reads only — it never touches a write endpoint, by construction.
 */
export async function runSelfTest(ctx: ToolContext): Promise<boolean> {
  const results: { name: string; ok: boolean; detail: string }[] = [];

  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  };

  await check("autocomplete", async () => {
    const hits = await ctx.api.autocomplete("elden ring");
    if (hits.length === 0) throw new Error("no suggestions returned");
    return `${hits.length} hits, first = ${hits[0]?.title} (id ${hits[0]?.id})`;
  });

  await check("resolve game", async () => {
    const ref = await ctx.api.resolveGame("elden-ring");
    if (!ref.id) throw new Error("no game id resolved");
    return `${ref.slug} → ${ref.id}`;
  });

  await check("game page", async () => {
    const ref = await ctx.api.resolveGame("elden-ring");
    const game = await ctx.api.getGame(ref);
    if (!game.title) throw new Error("no title");
    if (game.genres.length === 0) throw new Error("no genres — selector likely broken");
    if (game.averageRating === null) throw new Error("no average rating");
    return `${game.title} (${game.year}) · ${game.genres.join("/")} · ${game.averageRating}★`;
  });

  await check("search results", async () => {
    const results = await ctx.api.searchGames("hollow knight", 5);
    if (results.length === 0) throw new Error("no results");
    return `${results.length} results, first = ${results[0]?.title}`;
  });

  await check("browse", async () => {
    const page = await ctx.api.browseGames("popular", 1, {});
    if (page.items.length === 0) throw new Error("no games on the popular page");
    return `${page.items.length} games`;
  });

  const identity = ctx.session.getIdentity() ?? (await ctx.session.ensureAuthenticated());

  await check("identity", async () => `${identity.username} (id ${identity.userId})`);

  await check("own library", async () => {
    const page = await ctx.api.getLibrary(identity.username, { page: 1 });
    if (page.items.length === 0) throw new Error("library page parsed to zero entries");
    return `${page.items.length} entries, hasMore=${page.hasMore}`;
  });

  await check("own log state", async () => {
    const ref = await ctx.api.resolveGame("elden-ring");
    const log = await ctx.api.getGameLog(ref.id);
    return `status=${log.entry.status} rating=${log.entry.rating ?? "none"}`;
  });

  await check("batch log state", async () => {
    const map = await ctx.api.getBatchLogs([119133, 1029]);
    if (map.size === 0) throw new Error("batch endpoint returned nothing");
    return `${map.size} entries`;
  });

  await check("profile", async () => {
    const p = await ctx.api.getProfile(identity.username);
    return `played=${p.totalGames} backlog=${p.backlogCount} favourites=${p.favorites.length}`;
  });

  await check("journal", async () => {
    const page = await ctx.api.getJournal(identity.username, 1);
    return `${page.items.length} entries`;
  });

  await check("lists", async () => {
    const page = await ctx.api.getLists(identity.username, 1);
    return `${page.items.length} lists`;
  });

  await check("list membership", async () => {
    const ref = await ctx.api.resolveGame("elden-ring");
    const lists = await ctx.api.getGameListMembership(ref.id);
    if (lists.length === 0) throw new Error("no lists parsed from the add-to-list modal");
    return `${lists.length} lists, in ${lists.filter((l) => l.contains).length}`;
  });

  await check("library filters", async () => {
    const page = await ctx.api.queryLibrary(
      identity.username,
      { shelf: "backlog", sort: "avg-finish-time" },
      1,
    );
    if (page.items.length === 0) throw new Error("filtered library returned nothing");
    return `${page.items.length} backlog games by finish time`;
  });

  await check("release_platform filter", async () => {
    const page = await ctx.api.queryLibrary(
      identity.username,
      { shelf: "backlog", releasePlatform: "wiiu" },
      1,
    );
    return `${page.items.length} Wii U games in backlog`;
  });

  await check("playtime + histogram", async () => {
    const ref = await ctx.api.resolveGame("elden-ring");
    const g = await ctx.api.getGame(ref);
    if (g.playtime.averageHours === null) throw new Error("no playtime parsed");
    if (!g.ratingDistribution) throw new Error("no rating histogram parsed");
    return `avg ${g.playtime.averageHours}h, ${Object.keys(g.ratingDistribution).length} buckets`;
  });

  await check("company catalogue", async () => {
    const page = await ctx.api.browseCompany("fromsoftware", "release", 1);
    if (page.items.length === 0) throw new Error("no games on the company page");
    return `${page.company}: ${page.items.length} games (status attached)`;
  });

  await check("related games", async () => {
    const items = await ctx.api.getRelatedGames(621, "series");
    if (items.length === 0) throw new Error("series frame returned nothing");
    return `${items.length} games in the Call of Duty series`;
  });

  await check("activity feed", async () => {
    const page = await ctx.api.getActivity(identity.username, "friends", 1);
    return `${page.items.length} activity items`;
  });

  await check("follows", async () => {
    const page = await ctx.api.getFollows(identity.username, "following", 1);
    return `${page.items.length} following, ids=${page.items.filter((f) => f.userId).length}`;
  });

  await check("notifications", async () => {
    const n = await ctx.api.getNotifications();
    return n.empty ? "none (empty state)" : `${n.items.length} notifications`;
  });

  await check("play sessions", async () => {
    const log = await ctx.api.getGameLog(119133);
    const total = log.playthroughs.reduce((a, p) => a + p.sessions.length, 0);
    return `${log.playthroughs.length} playthroughs, ${total} sessions`;
  });

  await check("game reviews", async () => {
    const page = await ctx.api.getGameReviews("elden-ring", 1);
    if (page.items.length === 0) throw new Error("no reviews parsed");
    return `${page.items.length} reviews, first by ${page.items[0]?.author}`;
  });

  const failed = results.filter((r) => !r.ok);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    process.stdout.write(`${mark}  ${r.name.padEnd(width)}  ${r.detail}\n`);
  }
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} read paths healthy.\n`,
  );

  // Distinguish "the network dropped" from "the parser broke". Conflating them sends you
  // hunting for a markup change that never happened — and on a flaky connection to
  // Backloggd, the network is by far the likelier cause.
  const network = failed.filter((f) => isNetworkFailure(f.detail));
  const parsing = failed.filter((f) => !isNetworkFailure(f.detail));

  if (network.length > 0) {
    process.stdout.write(
      `\nNetwork trouble (not a parser problem): ${network.map((f) => f.name).join(", ")}.\n` +
        `  The request timed out or the connection dropped. Re-run before concluding anything;\n` +
        `  raise BACKLOGGD_MAX_RETRIES or BACKLOGGD_REQUEST_TIMEOUT_MS on a slow link.\n`,
    );
  }
  if (parsing.length > 0) {
    process.stdout.write(
      `\nParser failures: ${parsing.map((f) => f.name).join(", ")}.\n` +
        `  Backloggd's markup has probably changed — re-derive the selectors from a fresh page.\n`,
    );
  }
  return failed.length === 0;
}

function isNetworkFailure(detail: string): boolean {
  return /timeout|ECONNRESET|ETIMEDOUT|socket|ENOTFOUND|EAI_AGAIN|fetch failed|UND_ERR/i.test(
    detail,
  );
}
