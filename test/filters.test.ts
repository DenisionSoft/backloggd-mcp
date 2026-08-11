import { describe, expect, it } from "vitest";
import {
  buildBrowsePath,
  buildLibraryPath,
  resolveGenre,
  resolvePlatform,
} from "../src/filters.js";
import { BackloggdError } from "../src/errors.js";
import { GENRES, PLATFORMS } from "../src/vocab.js";
import { parseSessions, shiftDate, buildSessionFields } from "../src/parse/sessions.js";

describe("slug resolution", () => {
  it("accepts an exact slug", () => {
    expect(resolvePlatform("ps5")).toBe("ps5");
    expect(resolveGenre("simulator")).toBe("simulator");
  });

  it("accepts the display name", () => {
    expect(resolvePlatform("PlayStation 5")).toBe("ps5");
    expect(resolvePlatform("Wii U")).toBe("wiiu");
    expect(resolveGenre("RPG")).toBe("role-playing-rpg");
  });

  it("handles punctuation and spacing differences", () => {
    expect(resolvePlatform("playstation5")).toBe("ps5");
    expect(resolvePlatform("Xbox Series X|S")).toBe("series-x-s");
    expect(resolvePlatform("meta quest 3")).toBe("meta-quest-3");
  });

  it("resolves irregular slugs that could not be guessed", () => {
    // These are exactly the ones a naive slugifier gets wrong.
    expect(resolvePlatform("PlayStation 4")).toBe("ps4--1");
    expect(resolvePlatform("Sega Mega Drive/Genesis")).toBe("genesis-slash-megadrive");
  });

  it("rejects an unknown value with suggestions instead of passing it through", () => {
    // Passing an unknown slug through would make Backloggd return HTTP 500.
    try {
      resolveGenre("notarealgenre");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BackloggdError);
      expect((err as BackloggdError).hint).toContain("Did you mean");
    }
  });

  it("rejects an ambiguous partial match rather than picking one", () => {
    expect(() => resolvePlatform("oculus")).toThrow(BackloggdError);
  });

  it("has the vocabularies loaded", () => {
    expect(Object.keys(PLATFORMS).length).toBeGreaterThan(200);
    expect(Object.keys(GENRES).length).toBe(23);
    expect(PLATFORMS["meta-quest-3"]).toBe("Meta Quest 3");
  });
});

describe("library URL building", () => {
  it("builds a bare library path", () => {
    expect(buildLibraryPath("bob", {})).toBe("/u/bob/games/");
  });

  it("puts the sort in its own segment and filters in the next", () => {
    expect(buildLibraryPath("bob", { shelf: "backlog", sort: "avg-finish-time" })).toBe(
      "/u/bob/games/avg-finish-time/type:backlog/",
    );
  });

  it("joins multiple filters with semicolons", () => {
    const path = buildLibraryPath("bob", {
      shelf: "backlog",
      releasePlatform: "PS5",
      genre: "Simulator",
    });
    expect(path).toBe("/u/bob/games/added/type:backlog;release_platform:ps5;genre:simulator/");
  });

  it("always emits a sort segment when filters are present", () => {
    // The filter segment is positional — without a preceding sort, Backloggd reads
    // "type:backlog" as the sort name and returns HTTP 500. Regression test for a bug
    // the live selftest caught.
    const path = buildLibraryPath("bob", { shelf: "backlog" });
    expect(path).toBe("/u/bob/games/added/type:backlog/");
    expect(path.split("/").filter(Boolean)).toHaveLength(5);
  });

  it("still allows a bare library path with no segments", () => {
    expect(buildLibraryPath("bob", {})).toBe("/u/bob/games/");
  });

  it("applies sort direction", () => {
    expect(buildLibraryPath("bob", { sort: "release", order: "desc" })).toBe(
      "/u/bob/games/release:desc/",
    );
  });

  it("never puts a direction on shuffle", () => {
    // `shuffle:desc` is not a thing and makes the page error.
    expect(buildLibraryPath("bob", { sort: "shuffle", order: "desc" })).toBe(
      "/u/bob/games/shuffle/",
    );
  });

  it("converts a star rating to the wire scale", () => {
    expect(buildLibraryPath("bob", { ratingStars: 5 })).toContain("rating:10");
    expect(buildLibraryPath("bob", { ratingStars: 3.5 })).toContain("rating:7");
  });

  it("rejects an out-of-range rating", () => {
    expect(() => buildLibraryPath("bob", { ratingStars: 6 })).toThrow(BackloggdError);
  });

  it("builds browse paths with the same grammar", () => {
    expect(buildBrowsePath("rating", { releaseYear: "2026" })).toBe(
      "/games/lib/rating/release_year:2026/",
    );
    expect(buildBrowsePath("popular", {})).toBe("/games/lib/popular/");
  });
});

describe("play sessions", () => {
  it("shifts dates across month boundaries", () => {
    expect(shiftDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("normalises Backloggd's exclusive end date to the last played day", () => {
    const [s] = parseSessions([
      {
        id: 7,
        range_start_date: "2026-08-01",
        range_end_date: "2026-08-03",
        hours: 2,
        minutes: 30,
        note: "beat the boss",
        status: "completed",
        tags: ["fun"],
      },
    ]);
    expect(s).toMatchObject({
      id: 7,
      startDate: "2026-08-01",
      endDate: "2026-08-02",
      hours: 2,
      minutes: 30,
      note: "beat the boss",
      status: "completed",
      tags: ["fun"],
    });
  });

  it("keeps a single-day session on one day", () => {
    const [s] = parseSessions([
      { id: 1, range_start_date: "2026-08-01", range_end_date: "2026-08-01" },
    ]);
    expect(s?.startDate).toBe("2026-08-01");
    expect(s?.endDate).toBe("2026-08-01");
  });

  it("survives junk input", () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions("nope")).toEqual([]);
    expect(parseSessions([null, 3])).toEqual([]);
  });

  it("round-trips a session back to an exclusive end date", () => {
    const form = buildSessionFields(42, [
      { id: -1, startDate: "2026-08-01", hours: 1, note: "hi" },
    ]);
    expect(form["dates[42][0][range_start_date]"]).toBe("2026-08-01");
    expect(form["dates[42][0][range_end_date]"]).toBe("2026-08-02");
    // Only sessions flagged as edited are persisted by the server.
    expect(form["dates[42][0][edited]"]).toBe("true");
  });
});
