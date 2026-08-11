import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseGamePage } from "../src/parse/game-page.js";
import { parseLibraryPage } from "../src/parse/library.js";
import { parseAutocomplete, parseSearchResults } from "../src/parse/search.js";
import { parseListsPage } from "../src/parse/lists.js";
import { parseReviews } from "../src/parse/reviews.js";
import { parseJournal, parseProfile } from "../src/parse/profile.js";
import { parseBatchLogs, parseLogEdit } from "../src/parse/log.js";
import { parseUserLists } from "../src/parse/user-lists.js";
import { parseGameGrid, parseCompanyName } from "../src/parse/grid.js";
import { parseActivity, parseFollowList, parseNotifications } from "../src/parse/social.js";
import { PLAYED_STATUS_IDS, ratingToStars, starsToWire } from "../src/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

describe("game page", () => {
  const game = parseGamePage(fixture("game-auth.html"), "elden-ring");

  it("extracts core identity", () => {
    expect(game.title).toBe("Elden Ring");
    expect(game.id).toBe(119133);
    expect(game.slug).toBe("elden-ring");
    expect(game.year).toBe(2022);
  });

  it("extracts catalogue metadata", () => {
    expect(game.genres).toEqual(expect.arrayContaining(["Adventure", "RPG"]));
    expect(game.platforms).toEqual(expect.arrayContaining(["Windows PC", "PlayStation 5"]));
    expect(game.developers).toEqual(
      expect.arrayContaining(["FromSoftware", "Bandai Namco Entertainment"]),
    );
    expect(game.releaseDate).toBe("Feb 25, 2022");
  });

  it("extracts the aggregate rating on the user-facing 0.5-5 scale", () => {
    expect(game.averageRating).toBeCloseTo(4.54, 1);
    expect(game.ratingCount).toBeGreaterThan(100_000);
  });

  it("extracts a description and cover", () => {
    expect(game.description).toContain("FromSoftware");
    expect(game.coverUrl).toContain("igdb.com");
  });

  it("parses an unauthenticated page too", () => {
    const anon = parseGamePage(fixture("game.html"), "elden-ring");
    expect(anon.title).toBe("Elden Ring");
    expect(anon.genres.length).toBeGreaterThan(0);
  });
});

describe("library page", () => {
  const page = parseLibraryPage(fixture("lib-games.html"), 1);

  it("reads every card on the page", () => {
    expect(page.items.length).toBe(40);
  });

  it("detects that a further page exists", () => {
    expect(page.hasMore).toBe(true);
  });

  it("reads rating and status from the preloaded log block", () => {
    const superliminal = page.items.find((i) => i.game.slug === "superliminal");
    expect(superliminal).toBeDefined();
    // data-rating="7" on the wire is 3.5 stars to a user.
    expect(superliminal?.rating).toBe(3.5);
  });

  it("marks played games as played", () => {
    const driver = page.items.find((i) => i.game.slug === "driv3r--1");
    expect(driver?.status).toBe("played");
  });

  it("gives every entry a usable game reference", () => {
    for (const item of page.items) {
      expect(item.game.id).toBeGreaterThan(0);
      expect(item.game.slug).not.toBe("");
      expect(item.game.url).toContain("/games/");
    }
  });
});

describe("search", () => {
  it("parses autocomplete JSON", () => {
    const json = JSON.stringify({
      suggestions: [
        { value: "Elden Ring", data: { slug: "elden-ring", title: "Elden Ring", year: "2022", id: 119133 } },
        { value: "Broken", data: {} },
      ],
    });
    const hits = parseAutocomplete(json);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 119133, slug: "elden-ring", year: 2022 });
  });

  it("survives malformed JSON", () => {
    expect(parseAutocomplete("not json")).toEqual([]);
  });

  it("parses the turbo-stream search results", () => {
    const results = parseSearchResults(fixture("search-results.html"));
    expect(results.length).toBeGreaterThan(0);
    const elden = results.find((r) => r.slug === "elden-ring");
    expect(elden).toMatchObject({ id: 119133, title: "Elden Ring", year: 2022 });
    expect(elden?.platforms).toEqual(expect.arrayContaining(["Windows PC"]));
    expect(elden?.category).toBe("Main Game");
  });
});

describe("lists", () => {
  const page = parseListsPage(fixture("lib-lists.html"), 1);

  it("finds the user's lists", () => {
    expect(page.items.length).toBeGreaterThan(0);
    const inbox = page.items.find((l) => l.slug === "inbox");
    expect(inbox).toMatchObject({ name: "Inbox", gameCount: 25 });
    expect(inbox?.url).toContain("/list/inbox/");
  });
});

describe("profile", () => {
  const profile = parseProfile(fixture("profile.html"), "Denision");

  it("extracts stats by label rather than position", () => {
    expect(profile.totalGames).toBe(59);
    expect(profile.backlogCount).toBe(349);
  });

  it("extracts bio and favourites", () => {
    expect(profile.bio).toContain("Clickable");
    expect(profile.favorites.length).toBeGreaterThan(0);
    expect(profile.favorites[0]?.slug).toBeTruthy();
  });
});

describe("journal", () => {
  it("extracts play history entries", () => {
    const page = parseJournal(fixture("lib-journal.html"), 1);
    expect(page.items.length).toBeGreaterThan(0);
    const balatro = page.items.find((e) => e.game.slug === "balatro");
    expect(balatro).toBeDefined();
    expect(balatro?.platform).toBe("Windows PC");
  });
});

describe("reviews", () => {
  it("extracts review cards from the per-game turbo frame", () => {
    const page = parseReviews(fixture("greviews.html"), 1);
    expect(page.items.length).toBeGreaterThan(0);
    const first = page.items[0];
    expect(first?.author).toBeTruthy();
    expect(first?.authorUrl).toContain("/u/");
    // The fixture's first review is a five-star one (stars-top width:100%).
    expect(first?.rating).toBe(5);
  });
});

describe("log JSON", () => {
  it("parses /log/edit/ into a user entry", () => {
    const json = JSON.stringify({
      game_log: {
        id: 25491162,
        status: "played",
        rating: 0,
        is_play: false,
        is_playing: false,
        is_backlog: true,
        is_wishlist: false,
        game_liked: false,
        total_hours: 0,
        total_minutes: 0,
      },
      playthroughs: {},
      most_recent_playthrough_id: null,
    });
    const log = parseLogEdit(json, 119133);
    expect(log.entry.logId).toBe(25491162);
    expect(log.entry.status).toBe("backlog");
    expect(log.entry.rating).toBeNull();
    expect(log.playthroughs).toEqual([]);
  });

  it("parses the batch endpoint", () => {
    const json = JSON.stringify({
      "1029": { is_liked: false, game_log_id: 25686167, is_play: false, is_backlog: true, rating: 0 },
      "119133": { is_liked: true, game_log_id: 25491162, is_play: true, is_backlog: false, rating: 9 },
    });
    const map = parseBatchLogs(json);
    expect(map.size).toBe(2);
    expect(map.get(119133)).toMatchObject({ status: "played", rating: 4.5, liked: true });
    expect(map.get(1029)?.status).toBe("backlog");
  });

  it("treats a missing log as 'not in library'", () => {
    const log = parseLogEdit(JSON.stringify({ game_log: null }), 42);
    expect(log.entry.status).toBe("none");
    expect(log.entry.logId).toBeNull();
  });
});

describe("rating scale conversion", () => {
  it("round-trips half stars", () => {
    for (let wire = 1; wire <= 10; wire++) {
      const stars = ratingToStars(wire);
      expect(stars).not.toBeNull();
      expect(starsToWire(stars as number)).toBe(wire);
    }
  });

  it("treats 0 and null as unrated", () => {
    expect(ratingToStars(0)).toBeNull();
    expect(ratingToStars(null)).toBeNull();
  });

  it("rejects out-of-range ratings rather than silently clamping", () => {
    expect(() => starsToWire(0)).toThrow(RangeError);
    expect(() => starsToWire(5.5)).toThrow(RangeError);
    expect(() => starsToWire(-1)).toThrow(RangeError);
  });
});

describe("played-status ids", () => {
  /**
   * These ids are not sequential and not in menu order, so a plausible-looking guess
   * silently mislabels games (guessing completed=2 actually means "abandoned"). Pin
   * them against the real modal markup in the fixture rather than trusting the table.
   */
  it("match the status attributes in the live quick-status modal", () => {
    const html = fixture("game-auth.html");
    const fromMarkup = new Map<string, number>();
    const re = /<div class="[^"]*play-type-option[^"]*"\s+id="([a-z]+)"\s+status="(\d+)"/g;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      fromMarkup.set(m[1] as string, Number.parseInt(m[2] as string, 10));
    }

    expect(fromMarkup.size).toBe(5);
    for (const [name, id] of fromMarkup) {
      expect(PLAYED_STATUS_IDS[name as keyof typeof PLAYED_STATUS_IDS]).toBe(id);
    }
    // Spelled out, so a careless edit to the table fails loudly here.
    expect(PLAYED_STATUS_IDS.completed).toBe(0);
    expect(PLAYED_STATUS_IDS.played).toBe(5);
  });
});

describe("list membership", () => {
  const lists = parseUserLists(fixture("user-lists.html"));

  it("reads every list from the add-to-list modal", () => {
    expect(lists.length).toBeGreaterThan(5);
    for (const l of lists) {
      expect(l.listId).toBeGreaterThan(0);
      expect(l.name).not.toBe("");
    }
  });

  it("distinguishes lists that contain the game from those that do not", () => {
    const containing = lists.filter((l) => l.contains);
    const notContaining = lists.filter((l) => !l.contains);
    // The fixture is for a game in exactly one list, so both branches are exercised.
    expect(containing).toHaveLength(1);
    expect(notContaining.length).toBeGreaterThan(0);
    expect(containing[0]?.name).toBe("Together");
  });

  it("captures list size and a link", () => {
    const withCount = lists.find((l) => l.gameCount !== null);
    expect(withCount).toBeDefined();
    expect(withCount?.url).toContain("/list/");
  });
});

describe("playtime and rating distribution", () => {
  const game = parseGamePage(fixture("game-auth.html"), "elden-ring");

  it("extracts the three community playtime figures", () => {
    expect(game.playtime).toEqual({
      averageHours: 146,
      hoursToFinish: 97,
      hoursToMaster: 119,
    });
  });

  it("extracts the full half-star histogram", () => {
    const dist = game.ratingDistribution;
    expect(dist).not.toBeNull();
    expect(Object.keys(dist as object)).toHaveLength(10);
    expect(dist?.["0.5"]).toBe(398);
    expect(dist?.["5"]).toBe(74380);
  });

  it("has a histogram roughly consistent with the reported rating count", () => {
    // Backloggd's own two figures disagree slightly — the histogram sums to 136,229
    // against an aggregate of 136,323 (0.07%). They are evidently computed at different
    // times, so this is a sanity check that we are reading the right numbers, not an
    // invariant. Anything beyond ~1% drift would mean the parser is picking up the wrong
    // buckets.
    const total = Object.values(game.ratingDistribution ?? {}).reduce((a, b) => a + b, 0);
    const count = game.ratingCount as number;
    expect(Math.abs(total - count) / count).toBeLessThan(0.01);
  });
});

describe("game grid (company / related pages)", () => {
  it("parses a company catalogue with the caller's own status attached", () => {
    const page = parseGameGrid(fixture("company.html"), 1);
    expect(page.items.length).toBe(60);
    for (const item of page.items) {
      expect(item.game.id).toBeGreaterThan(0);
      expect(item.game.slug).not.toBe("");
      expect(["played", "playing", "backlog", "wishlist", "none"]).toContain(item.status);
    }
    expect(parseCompanyName(fixture("company.html"))).toBe("FromSoftware");
  });

  it("parses a related-games frame", () => {
    const items = parseGameGrid(fixture("related-series.html"), 1).items;
    // The Call of Duty series frame lists the classic-era entries.
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.map((i) => i.game.title)).toEqual(
      expect.arrayContaining(["Call of Duty 2", "Call of Duty 3"]),
    );
  });
});

describe("social pages", () => {
  it("parses the activity feed with kinds and timestamps", () => {
    const page = parseActivity(fixture("activity.html"), 1);
    expect(page.items.length).toBeGreaterThan(0);
    const first = page.items[0];
    expect(first?.text).toBeTruthy();
    expect(first?.actor).toBeTruthy();
    expect(first?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(["liked", "played", "rated", "reviewed", "followed", "list", "backlogged", "wishlisted", "playing", "activity"]).toContain(first?.kind);
  });

  it("parses the following list including the numeric user ids", () => {
    const page = parseFollowList(fixture("following.html"), 1);
    expect(page.items.length).toBeGreaterThan(0);
    const withId = page.items.find((u) => u.userId !== null);
    // The numeric id is what set_follow_user needs and it exists nowhere else.
    expect(withId?.userId).toBeGreaterThan(0);
    expect(withId?.youFollow).toBe(true);
  });

  it("reports an empty notifications page as empty rather than inventing rows", () => {
    const result = parseNotifications(fixture("notifications.html"));
    expect(result.empty).toBe(true);
    expect(result.items).toEqual([]);
  });
});

describe("absent vs null fields", () => {
  /**
   * `year: null` on a grid row reads as "this game has no release year", which is false —
   * Backloggd's grid markup simply has no year in it. The key is omitted instead so the
   * distinction between "unknown" and "none" survives into the tool output.
   */
  it("omits year on library rows rather than nulling it", () => {
    const page = parseLibraryPage(fixture("lib-games.html"), 1);
    const first = page.items[0]?.game as Record<string, unknown>;
    expect(first).toBeDefined();
    expect("year" in first).toBe(false);
    expect(JSON.stringify(first)).not.toContain('"year"');
  });

  it("omits year on company and related grids too", () => {
    for (const f of ["company.html", "related-series.html"]) {
      const g = parseGameGrid(fixture(f), 1).items[0]?.game as Record<string, unknown>;
      expect(g, f).toBeDefined();
      expect("year" in g, f).toBe(false);
    }
  });

  it("still reports a real year where the source has one", () => {
    expect(parseGamePage(fixture("game-auth.html"), "elden-ring").year).toBe(2022);
    const elden = parseSearchResults(fixture("search-results.html")).find(
      (r) => r.slug === "elden-ring",
    );
    expect(elden?.year).toBe(2022);
  });
});

describe("parent game (add-on content)", () => {
  /**
   * Replaces an always-null `category`: `.game-result-type` exists only on search-result
   * cards, never on a game page, so that field could never be populated. This attribute
   * is real and distinguishes a top-level game from DLC/expansions/editions.
   */
  it("reports null for a top-level game", () => {
    expect(parseGamePage(fixture("game-auth.html"), "elden-ring").parentGameSlug).toBeNull();
  });

  it("reads the parent slug out of #game-page-meta", () => {
    const html = '<div id="game-page-meta" data-game-id="1" data-game-slug="x" ' +
      'data-parent-game-slug="elden-ring" data-name="X"></div>' +
      '<div class="game-title-section"><h1>Shadow of the Erdtree</h1></div>';
    expect(parseGamePage(html, "x").parentGameSlug).toBe("elden-ring");
  });

  it("keeps the precise category available from search results", () => {
    // Backloggd prints Main Game / DLC / Expansion / Bundle only on search cards.
    const elden = parseSearchResults(fixture("search-results.html")).find(
      (r) => r.slug === "elden-ring",
    );
    expect(elden?.category).toBe("Main Game");
  });
});
