import { BASE_URL } from "../config.js";
import { intOrNull, load } from "./helpers.js";

export interface ListMembership {
  listId: number;
  name: string;
  /** True when this list already contains the game the modal was opened for. */
  contains: boolean;
  gameCount: number | null;
  url: string | null;
}

/**
 * Parse `GET /render/user_lists?game_id={id}` — the "add to list" modal.
 *
 * This is the only endpoint that answers "which of my lists contain this game" in a
 * single request. Each list is rendered as a checkbox carrying `list_id` and an
 * `existing` attribute that is `"true"` exactly when the game is already in it; walking
 * every list page and intersecting would otherwise cost dozens of requests per game.
 */
export function parseUserLists(html: string): ListMembership[] {
  const $ = load(html);
  const out: ListMembership[] = [];

  $("input.list-checkbox[list_id]").each((_, el) => {
    const input = $(el);
    const listId = intOrNull(input.attr("list_id"));
    if (!listId) return;

    const label = $(`label[list_id="${listId}"]`).first();
    const name = label.find(".list-entry-title").first().text().replace(/\s+/g, " ").trim();
    const countText = label.find(".subtitle-text").first().text();
    const href = label.find("a[href*='/list/']").first().attr("href");

    out.push({
      listId,
      name: name || `List ${listId}`,
      contains: input.attr("existing") === "true",
      gameCount: intOrNull(countText),
      url: href ? new URL(href, BASE_URL).toString() : null,
    });
  });

  return out;
}
