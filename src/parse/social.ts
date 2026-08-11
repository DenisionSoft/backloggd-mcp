import { BASE_URL } from "../config.js";
import type { Page } from "../types.js";
import { intOrNull, load, makePage } from "./helpers.js";

export interface ActivityItem {
  /** Icon-derived kind: liked, played, reviewed, followed, listed… */
  kind: string;
  /** The activity rendered as plain text, e.g. "VitalNPC liked X's review of Y". */
  text: string;
  actor: string | null;
  gameSlug: string | null;
  /** ISO timestamp from the tooltip, which is the only exact time on the page. */
  timestamp: string | null;
  relativeTime: string | null;
}

/** Map the Font Awesome icon on an activity row to a stable kind. */
function kindFromIcon(cls: string): string {
  if (/fa-heart/.test(cls)) return "liked";
  if (/gamepad/.test(cls)) return "played";
  if (/fa-star/.test(cls)) return "rated";
  if (/fa-pen|fa-message|review/.test(cls)) return "reviewed";
  if (/fa-user/.test(cls)) return "followed";
  if (/fa-list|fa-layer/.test(cls)) return "list";
  if (/fa-books|backlog/.test(cls)) return "backlogged";
  if (/fa-gift/.test(cls)) return "wishlisted";
  if (/fa-play/.test(cls)) return "playing";
  return "activity";
}

/** Parse `/u/{user}/activity/{you|friends|inbound}/`. */
export function parseActivity(html: string, page = 1): Page<ActivityItem> {
  const $ = load(html);
  const items: ActivityItem[] = [];

  $("#activities-list .activity").each((_, el) => {
    const row = $(el);
    const icon = row.find(".activity-icon i").first().attr("class") ?? "";
    const body = row.find(".col.pl-1").first();
    const text = body.text().replace(/\s+/g, " ").trim();
    if (!text) return;

    const tooltip = row.find(".time-tooltip").first();
    const timestamp = /datetime="([^"]+)"/.exec(tooltip.attr("data-tippy-content") ?? "")?.[1];

    items.push({
      kind: kindFromIcon(icon),
      text,
      actor: /\/u\/([^/?#"]+)/.exec(body.find("a[href^='/u/']").first().attr("href") ?? "")?.[1] ?? null,
      gameSlug:
        /\/games\/([^/?#"]+)/.exec(body.find("a[href^='/games/']").first().attr("href") ?? "")?.[1] ??
        null,
      timestamp: timestamp ?? null,
      relativeTime: tooltip.text().trim() || null,
    });
  });

  return makePage(items, page, $);
}

export interface FollowEntry {
  username: string;
  /** Numeric id — the only thing `set_follow_user` accepts, and it lives only here. */
  userId: number | null;
  url: string;
  avatarUrl: string | null;
  since: string | null;
  youFollow: boolean;
}

/** Parse `/u/{user}/following/` or `/followers/`. */
export function parseFollowList(html: string, page = 1): Page<FollowEntry> {
  const $ = load(html);
  const items: FollowEntry[] = [];
  const seen = new Set<string>();

  $(".friend-listing").each((_, el) => {
    const row = $(el);
    const href = row.find("a[href^='/u/']").first().attr("href");
    const username = /\/u\/([^/?#]+)/.exec(href ?? "")?.[1];
    if (!username || seen.has(username)) return;
    seen.add(username);

    const btn = row.find(".friend-btn").first();
    items.push({
      username,
      userId: intOrNull(btn.attr("user_id")),
      url: `${BASE_URL}/u/${username}/`,
      avatarUrl: row.find("img").first().attr("src") ?? null,
      since: row.find(".subtitle-text").first().text().replace(/^Since\s*/i, "").trim() || null,
      youFollow: btn.attr("is_following") === "true",
    });
  });

  return makePage(items, page, $);
}

export interface Notification {
  text: string;
  url: string | null;
  timestamp: string | null;
  unread: boolean;
}

/**
 * Parse `/notifications/`.
 *
 * Written defensively: the account this was developed against had none, so only the
 * empty state (`#notifications-container` with "No recent notifications") was ever
 * observed. The row selectors below are a best effort over the container's children and
 * should be re-checked against an account that actually has notifications.
 */
export function parseNotifications(html: string): { items: Notification[]; empty: boolean } {
  const $ = load(html);
  const container = $("#notifications-container");
  const text = container.text().replace(/\s+/g, " ").trim();

  if (/no recent notifications/i.test(text)) return { items: [], empty: true };

  const items: Notification[] = [];
  container.find(".notification, .notification-item, .row").each((_, el) => {
    const row = $(el);
    if (row.find(".notification, .notification-item").length > 0) return; // container row
    const body = row.text().replace(/\s+/g, " ").trim();
    if (!body) return;
    const href = row.find("a").first().attr("href");
    const tooltip = row.find(".time-tooltip").first();
    items.push({
      text: body,
      url: href ? new URL(href, BASE_URL).toString() : null,
      timestamp:
        /datetime="([^"]+)"/.exec(tooltip.attr("data-tippy-content") ?? "")?.[1] ??
        row.find("time").first().attr("datetime") ??
        null,
      unread: row.hasClass("unread") || row.find(".unread").length > 0,
    });
  });

  return { items, empty: items.length === 0 };
}
