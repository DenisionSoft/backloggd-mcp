import { z } from "zod";
import { defineTool, type AnyToolDef } from "./types.js";
import { consumeConfirmation, issueConfirmation } from "../confirm.js";
import { assertUnambiguous } from "../api/index.js";
import { BackloggdError, ConfirmationRequiredError } from "../errors.js";
import type { ListType, PlayedStatus } from "../types.js";

const gameArg = z
  .string()
  .describe("Game title, slug, or numeric Backloggd id.");

const confirmArg = z
  .string()
  .optional()
  .describe(
    "Confirmation token. Leave this out on the first call: the tool will return a " +
      "preview of exactly what would be destroyed, together with a token. Show that " +
      "preview to the user, get their agreement, and only then call again with the token.",
  );

export const writeTools: AnyToolDef[] = [
  defineTool({
    name: "set_game_status",
    title: "Set a game's shelf",
    description:
      "Move a game to one of your shelves: played, playing, backlog or wishlist. " +
      "Use 'none' to take it off all shelves without deleting your rating, review or logs. " +
      "Safe to call repeatedly — it reads the current state and only changes what differs.",
    write: true,
    inputSchema: {
      game: gameArg,
      status: z
        .enum(["played", "playing", "backlog", "wishlist", "none"])
        .describe("Target shelf. 'none' removes it from all shelves."),
    },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const entry = await ctx.api.setStatus(ref.id, args["status"] as never);
      return { game: ref, entry, message: `${ref.title ?? ref.slug} → ${entry.status}` };
    },
  }),

  defineTool({
    name: "set_played_status",
    title: "Set completion status",
    description:
      "Set how you finished a played game: completed, retired, shelved, abandoned, or " +
      "plain played. The game must already be on your played shelf.",
    write: true,
    inputSchema: {
      game: gameArg,
      status: z.enum(["played", "completed", "retired", "shelved", "abandoned"]),
    },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const entry = await ctx.api.setPlayedStatus(ref.id, args["status"] as PlayedStatus);
      return { game: ref, entry };
    },
  }),

  defineTool({
    name: "rate_game",
    title: "Rate a game",
    description:
      "Rate a game from 0.5 to 5 stars, in half-star steps. This is the same scale shown " +
      "on the site — do not pass Backloggd's internal 1-10 value.",
    write: true,
    inputSchema: {
      game: gameArg,
      stars: z
        .number()
        .min(0.5)
        .max(5)
        .describe("0.5 to 5, in steps of 0.5. E.g. 4.5 for four and a half stars."),
    },
    async handler(args, ctx) {
      const stars = args["stars"] as number;
      if (Math.round(stars * 2) !== stars * 2) {
        throw new BackloggdError(
          `Rating must be in half-star steps; got ${stars}.`,
          "BAD_INPUT",
          "Use 0.5, 1, 1.5, … 5.",
        );
      }
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const entry = await ctx.api.rateGame(ref.id, stars);
      return { game: ref, entry, message: `Rated ${ref.title ?? ref.slug} ${stars}/5` };
    },
  }),

  defineTool({
    name: "set_game_like",
    title: "Like or unlike a game",
    description: "Toggle the heart on a game.",
    write: true,
    inputSchema: { game: gameArg, liked: z.boolean() },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const entry = await ctx.api.setLike(ref.id, args["liked"] as boolean);
      return { game: ref, entry };
    },
  }),

  defineTool({
    name: "log_game",
    title: "Create or update a log",
    description:
      "Write a full log for a game: rating, review text, completion status, play dates and " +
      "playtime. Omitted fields keep their current values, and shelves you do not mention " +
      "are preserved. Pass playthrough_id to edit an existing log instead of adding one.",
    write: true,
    inputSchema: {
      game: gameArg,
      playthrough_id: z
        .number()
        .int()
        .optional()
        .describe("Existing playthrough to update. Omit to create a new log."),
      stars: z.number().min(0.5).max(5).optional().describe("0.5-5 in half-star steps."),
      review: z.string().optional().describe("Review text. Markdown-ish, as on the site."),
      review_has_spoilers: z.boolean().default(false),
      status: z
        .enum(["played", "completed", "retired", "shelved", "abandoned"])
        .optional()
        .describe("Completion status for this log."),
      start_date: z.string().optional().describe("YYYY-MM-DD."),
      finish_date: z.string().optional().describe("YYYY-MM-DD."),
      hours_played: z.number().int().min(0).optional(),
      minutes_played: z.number().int().min(0).max(59).optional(),
      is_replay: z.boolean().default(false),
      is_mastered: z.boolean().default(false),
      title: z.string().optional().describe("Log title, e.g. 'First playthrough'."),
    },
    async handler(args, ctx) {
      const stars = args["stars"] as number | undefined;
      if (stars !== undefined && Math.round(stars * 2) !== stars * 2) {
        throw new BackloggdError(`Rating must be in half-star steps; got ${stars}.`, "BAD_INPUT");
      }
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const log = await ctx.api.saveLog({
        gameId: ref.id,
        playthroughId: args["playthrough_id"] as number | undefined,
        title: args["title"] as string | undefined,
        stars: stars ?? null,
        review: args["review"] as string | undefined,
        reviewHasSpoilers: args["review_has_spoilers"] as boolean,
        status: args["status"] as PlayedStatus | undefined,
        startDate: args["start_date"] as string | undefined,
        finishDate: args["finish_date"] as string | undefined,
        hoursPlayed: args["hours_played"] as number | undefined,
        minutesPlayed: args["minutes_played"] as number | undefined,
        isReplay: args["is_replay"] as boolean,
        isMastered: args["is_mastered"] as boolean,
      });
      return { game: ref, entry: log.entry, playthroughs: log.playthroughs };
    },
  }),

  defineTool({
    name: "add_game_to_lists",
    title: "Add or remove a game from lists",
    description:
      "Add a game to lists and/or remove it from others in one call. List ids come from " +
      "get_lists.",
    write: true,
    inputSchema: {
      game: gameArg,
      add_list_ids: z.array(z.number().int()).default([]),
      remove_list_ids: z.array(z.number().int()).default([]),
    },
    async handler(args, ctx) {
      const add = args["add_list_ids"] as number[];
      const remove = args["remove_list_ids"] as number[];
      if (add.length === 0 && remove.length === 0) {
        throw new BackloggdError("Nothing to do: no lists given.", "BAD_INPUT");
      }
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      await ctx.api.updateGameLists(ref.id, add, remove);
      return { game: ref, added: add, removed: remove };
    },
  }),

  defineTool({
    name: "create_list",
    title: "Create a list",
    description:
      "Create a new, empty game list. Use add_game_to_lists afterwards to populate it.",
    write: true,
    inputSchema: {
      name: z.string().min(1).max(128).describe("List title, up to 128 characters."),
      type: z
        .enum(["unranked", "ranked", "goty"])
        .default("unranked")
        .describe("'ranked' numbers its entries; 'goty' is a game-of-the-year list."),
      year: z
        .number()
        .int()
        .optional()
        .describe("Required only for a 'goty' list."),
    },
    async handler(args, ctx) {
      const type = args["type"] as ListType;
      const year = args["year"] as number | undefined;
      if (type === "goty" && year === undefined) {
        throw new BackloggdError("A 'goty' list needs a year.", "BAD_INPUT");
      }
      const result = await ctx.api.createList(args["name"] as string, type, year);
      return { created: args["name"], type, url: result.url };
    },
  }),

  defineTool({
    name: "set_follow_user",
    title: "Follow or unfollow a user",
    description: "Follow or unfollow another Backloggd user by their numeric user id.",
    write: true,
    inputSchema: { user_id: z.number().int(), follow: z.boolean() },
    async handler(args, ctx) {
      await ctx.api.setFollow(args["user_id"] as number, args["follow"] as boolean);
      return { userId: args["user_id"], following: args["follow"] };
    },
  }),

  defineTool({
    name: "like_review",
    title: "Like or unlike a review",
    description: "Toggle your like on someone's review.",
    write: true,
    inputSchema: { review_id: z.number().int(), liked: z.boolean() },
    async handler(args, ctx) {
      await ctx.api.likeReview(args["review_id"] as number, args["liked"] as boolean);
      return { reviewId: args["review_id"], liked: args["liked"] };
    },
  }),

  defineTool({
    name: "log_play_session",
    title: "Log a dated play session",
    description:
      "Record that you played a game on a particular date, with optional duration and a " +
      "note — the building block of a play journal. Attaches to an existing playthrough; " +
      "get_play_sessions lists their ids. Existing sessions and shelf state are preserved.",
    write: true,
    inputSchema: {
      game: gameArg,
      playthrough_id: z
        .number()
        .int()
        .optional()
        .describe("Which playthrough to attach to. Defaults to the most recent one."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD."),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("For a session spanning several days. Defaults to the start date."),
      hours: z.number().int().min(0).optional(),
      minutes: z.number().int().min(0).max(59).optional(),
      note: z.string().optional().describe("What you did, e.g. 'beat the Acorn deck'."),
      status: z
        .enum(["played", "completed", "retired", "shelved", "abandoned"])
        .optional()
        .describe("Completion status reached in this session."),
    },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const log = await ctx.api.getGameLog(ref.id);

      let playthroughId = args["playthrough_id"] as number | undefined;
      if (playthroughId === undefined) {
        const last = log.playthroughs.at(-1);
        if (!last) {
          throw new BackloggdError(
            `"${ref.title ?? ref.slug}" has no playthrough to attach a session to.`,
            "NOT_FOUND",
            "Call log_game first to create one, then retry.",
          );
        }
        playthroughId = last.id;
      }

      const existing =
        log.playthroughs.find((p) => p.id === playthroughId)?.sessions ?? [];

      const result = await ctx.api.savePlaySessions(ref.id, playthroughId, [
        // Re-send existing sessions so the save does not drop them.
        ...existing.map((sn) => ({
          id: sn.id,
          startDate: sn.startDate ?? (args["date"] as string),
          endDate: sn.endDate ?? undefined,
          hours: sn.hours ?? undefined,
          minutes: sn.minutes ?? undefined,
          note: sn.note ?? undefined,
          status: sn.status ?? undefined,
        })),
        {
          id: -1,
          startDate: args["date"] as string,
          endDate: args["end_date"] as string | undefined,
          hours: args["hours"] as number | undefined,
          minutes: args["minutes"] as number | undefined,
          note: args["note"] as string | undefined,
          status: args["status"] as PlayedStatus | undefined,
        },
      ]);

      const updated = result.playthroughs.find((p) => p.id === playthroughId);
      return { game: ref, playthroughId, sessions: updated?.sessions ?? [] };
    },
  }),

  defineTool({
    name: "reorder_list",
    title: "Reorder or annotate list entries",
    description:
      "Set the order of a list's entries, and optionally a note on each. Pass the FULL " +
      "ordered set of entry ids — anything omitted may be dropped. Entry ids come from " +
      "get_list. Most useful for ranked lists.",
    write: true,
    inputSchema: {
      list_id: z.number().int().describe("Numeric list id from get_lists."),
      entries: z
        .array(
          z.object({
            entry_id: z.number().int(),
            note: z.string().optional(),
          }),
        )
        .min(1)
        .describe("Entries in the desired order, first = position 1."),
    },
    async handler(args, ctx) {
      const entries = args["entries"] as { entry_id: number; note?: string }[];
      await ctx.api.updateListEntries(
        args["list_id"] as number,
        entries.map((e, i) => ({ entryId: e.entry_id, position: i + 1, note: e.note })),
      );
      return { listId: args["list_id"], reordered: entries.length };
    },
  }),

  defineTool({
    name: "add_favorite_game",
    title: "Add a game to your profile favourites",
    description:
      "Pin a game to the favourites row on your profile. Backloggd allows five; adding a " +
      "sixth is rejected by the site. Removing one is only possible through profile " +
      "settings on the website, so this server does not offer it.",
    write: true,
    inputSchema: { game: gameArg },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      await ctx.api.addFavorite(ref.id);
      return { game: ref, favorited: true };
    },
  }),

  defineTool({
    name: "save_review_draft",
    title: "Save a review draft",
    description:
      "Save review text as a draft without publishing it. The draft is account-wide (not " +
      "per game) — it is the scratch buffer behind the site's review editor. Use log_game " +
      "to actually publish a review against a game.",
    write: true,
    inputSchema: { review: z.string().min(1) },
    async handler(args, ctx) {
      await ctx.api.saveReviewDraft(args["review"] as string);
      return { saved: true, length: (args["review"] as string).length };
    },
  }),

  defineTool({
    name: "post_comment",
    title: "Comment on a review or list (public)",
    description:
      "Post a PUBLIC comment on someone's review or list, under your username. Because " +
      "this is visible to other people and not something you can quietly undo, it requires " +
      "confirmation: call once without a token to see exactly what would be posted and " +
      "where, show that to the user, and only proceed with their agreement.",
    write: true,
    destructive: true,
    inputSchema: {
      target: z.enum(["review", "list"]),
      target_id: z.number().int(),
      body: z.string().min(1).max(5000),
      confirmation_token: confirmArg,
    },
    async handler(args, ctx) {
      const target = args["target"] as "review" | "list";
      const id = args["target_id"] as number;
      const body = args["body"] as string;

      requireConfirmation({
        action: "post_comment",
        target: `${target}:${id}`,
        supplied: args["confirmation_token"] as string | undefined,
        summary: `Post a public comment on ${target} #${id}, visible to everyone.`,
        willDelete: { willPost: body, on: `${target} #${id}`, visibility: "public" },
        preserved: "Nothing is deleted — but the comment is public and attributed to you.",
      });

      await ctx.api.postComment(target, id, body);
      return { posted: true, target, targetId: id };
    },
  }),

  // ------------------------------------------------------------ destructive

  defineTool({
    name: "remove_rating",
    title: "Remove a rating",
    description:
      "Delete your rating for a game, keeping the game in your library. Requires " +
      "confirmation: call once without a token to see what would be removed.",
    write: true,
    destructive: true,
    inputSchema: { game: gameArg, confirmation_token: confirmArg },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const log = await ctx.api.getGameLog(ref.id);

      if (log.entry.rating === null) {
        return { game: ref, message: "No rating to remove — nothing was changed." };
      }
      if (!log.entry.logId) {
        throw new BackloggdError(`No log entry exists for ${ref.slug}.`, "NOT_FOUND");
      }

      requireConfirmation({
        action: "remove_rating",
        target: String(ref.id),
        supplied: args["confirmation_token"] as string | undefined,
        summary: `Remove your ${log.entry.rating}-star rating of "${ref.title ?? ref.slug}".`,
        willDelete: { rating: log.entry.rating },
        preserved: "Your shelf, review, logs and playtime are not affected.",
      });

      const entry = await ctx.api.removeRating(ref.id, log.entry.logId);
      return { game: ref, entry, message: "Rating removed." };
    },
  }),

  defineTool({
    name: "delete_playthrough",
    title: "Delete one playthrough",
    description:
      "Delete a single playthrough log, including its review and any journal sessions " +
      "attached to it. Requires confirmation: call once without a token to see what " +
      "would be deleted.",
    write: true,
    destructive: true,
    inputSchema: {
      game: gameArg,
      playthrough_id: z.number().int().describe("From get_my_game_log."),
      confirmation_token: confirmArg,
    },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const playthroughId = args["playthrough_id"] as number;
      const log = await ctx.api.getGameLog(ref.id);
      const target = log.playthroughs.find((p) => p.id === playthroughId);

      if (!target) {
        throw new BackloggdError(
          `No playthrough ${playthroughId} on "${ref.title ?? ref.slug}".`,
          "NOT_FOUND",
          `Known playthrough ids: ${log.playthroughs.map((p) => p.id).join(", ") || "none"}.`,
        );
      }

      requireConfirmation({
        action: "delete_playthrough",
        target: `${ref.id}:${playthroughId}`,
        supplied: args["confirmation_token"] as string | undefined,
        summary: `Delete playthrough ${playthroughId} of "${ref.title ?? ref.slug}".`,
        willDelete: {
          playthrough: target.title ?? `#${playthroughId}`,
          rating: target.rating,
          review: target.review ? `${target.review.slice(0, 120)}…` : null,
          dates: { start: target.startDate, finish: target.finishDate },
          playtime: { hours: target.hoursPlayed, minutes: target.minutesPlayed },
        },
        preserved: "Other playthroughs of this game are not affected.",
      });

      await ctx.api.deletePlaythrough(ref.id, playthroughId);
      return { game: ref, deletedPlaythroughId: playthroughId };
    },
  }),

  defineTool({
    name: "remove_game_from_library",
    title: "Remove a game entirely (irreversible)",
    description:
      "IRREVERSIBLE. Wipes everything you have for this game: every log and playthrough, " +
      "your review, your rating, tracked playtime, library entries and like status. " +
      "Backloggd offers no undo. Requires confirmation — call once without a token to get " +
      "a full inventory of what will be destroyed, show it to the user, and only proceed " +
      "with their explicit agreement.",
    write: true,
    destructive: true,
    inputSchema: { game: gameArg, confirmation_token: confirmArg },
    async handler(args, ctx) {
      const ref = assertUnambiguous(
        await ctx.api.resolveGame(args["game"] as string),
        args["game"] as string,
      );
      const log = await ctx.api.getGameLog(ref.id);

      if (!log.entry.logId) {
        return {
          game: ref,
          message: `"${ref.title ?? ref.slug}" is not in your library — nothing to remove.`,
        };
      }

      requireConfirmation({
        action: "remove_game_from_library",
        target: String(ref.id),
        supplied: args["confirmation_token"] as string | undefined,
        summary:
          `Permanently delete ALL of your Backloggd data for "${ref.title ?? ref.slug}". ` +
          `This cannot be undone.`,
        willDelete: {
          shelf: log.entry.status,
          completionStatus: log.entry.playedStatus,
          rating: log.entry.rating,
          liked: log.entry.liked,
          playtime: {
            hours: log.entry.hoursPlayed,
            minutes: log.entry.minutesPlayed,
          },
          playthroughCount: log.playthroughs.length,
          playthroughs: log.playthroughs.map((p) => ({
            id: p.id,
            title: p.title,
            rating: p.rating,
            hasReview: Boolean(p.review),
            reviewPreview: p.review ? `${p.review.slice(0, 120)}…` : null,
          })),
        },
        preserved: "Nothing is preserved. The game is removed from your account entirely.",
      });

      await ctx.api.unlog(ref.id, log.entry.logId);
      return { game: ref, removed: true, message: `Removed "${ref.title ?? ref.slug}".` };
    },
  }),

  defineTool({
    name: "delete_list",
    title: "Delete a list (irreversible)",
    description:
      "IRREVERSIBLE. Deletes an entire list and everything in it. Requires confirmation — " +
      "call once without a token to see the list name and how many games it holds.",
    write: true,
    destructive: true,
    inputSchema: {
      list_id: z.number().int().describe("Numeric list id from get_lists."),
      confirmation_token: confirmArg,
    },
    async handler(args, ctx) {
      const listId = args["list_id"] as number;
      const username = (await ctx.session.ensureAuthenticated()).username;

      // The lists index does not expose numeric ids, so the preview cannot name the
      // target with certainty. Show every list the user has and say so plainly, rather
      // than implying a match we have not actually made.
      const lists = await ctx.api.getLists(username, 1);

      requireConfirmation({
        action: "delete_list",
        target: String(listId),
        supplied: args["confirmation_token"] as string | undefined,
        summary: `Permanently delete list #${listId}. This cannot be undone.`,
        willDelete: {
          listId,
          caution:
            "This id could not be matched to a name — Backloggd's list index does not " +
            "expose numeric ids. Confirm with the user which list this is before proceeding.",
          yourLists: lists.items.map((l) => ({
            name: l.name,
            slug: l.slug,
            games: l.gameCount,
            url: l.url,
          })),
        },
        preserved: "The games themselves stay in your library; only the list is destroyed.",
      });

      await ctx.api.deleteList(listId);
      return { deleted: true, listId };
    },
  }),

  defineTool({
    name: "delete_comment",
    title: "Delete a comment (irreversible)",
    description: "IRREVERSIBLE. Deletes one of your comments. Requires confirmation.",
    write: true,
    destructive: true,
    inputSchema: {
      comment_id: z.number().int(),
      confirmation_token: confirmArg,
    },
    async handler(args, ctx) {
      const id = args["comment_id"] as number;
      requireConfirmation({
        action: "delete_comment",
        target: String(id),
        supplied: args["confirmation_token"] as string | undefined,
        summary: `Permanently delete comment #${id}.`,
        willDelete: { commentId: id },
        preserved: "Nothing else is affected.",
      });
      await ctx.api.deleteComment(id);
      return { deleted: true, commentId: id };
    },
  }),
];


/**
 * Enforce two-phase confirmation.
 *
 * On the first call there is no token, so this throws with a preview of the damage plus
 * a freshly minted token. The token cannot be guessed or constructed, so the only route
 * to a successful second call runs through the preview being returned into the
 * conversation — which is precisely the point: the user gets to see what is about to be
 * destroyed before it happens.
 */
function requireConfirmation(opts: {
  action: string;
  target: string;
  supplied: string | undefined;
  summary: string;
  willDelete: unknown;
  preserved: string;
}): void {
  const result = consumeConfirmation(opts.action, opts.target, opts.supplied);
  if (result.ok) return;

  const token = issueConfirmation(opts.action, opts.target);
  const reason =
    result.reason === "expired"
      ? "That confirmation token had expired, so a new one was issued."
      : result.reason === "mismatch"
        ? "That confirmation token was not valid for this exact action and game."
        : undefined;

  throw new ConfirmationRequiredError(
    `${opts.summary} Confirmation required before this can proceed.`,
    {
      reason,
      summary: opts.summary,
      willBeDeleted: opts.willDelete,
      preserved: opts.preserved,
      nextStep:
        "Show the user exactly what is listed under willBeDeleted and ask them to " +
        "confirm. If they agree, call this tool again with confirmation_token set to " +
        "the value below. Do not call again without asking them first.",
    },
    token,
  );
}