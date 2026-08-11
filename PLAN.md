# Backloggd MCP Server — Research & Implementation Plan

**Status:** research complete, ready to build
**Date:** 2026-08-11
**Verdict:** Build an MCP server (not a skill), in TypeScript, distributed via `npx`.

---

## 1. Executive summary

Backloggd has **no public API**, but it is a plain Rails 7 application (Turbo + jQuery, no SPA) whose
entire feature set is driven by predictable, same-origin AJAX endpoints. Those endpoints are
enumerable from the front-end bundle, they accept ordinary form-encoded bodies, and they authenticate
with a single session cookie plus a Rails CSRF token. There is **no bot challenge, no JS challenge,
and no user-agent filtering**. Every read and write operation the user described — search, metadata,
statuses, ratings, logs, reviews, lists, journal, social — maps cleanly onto an endpoint that has been
identified and, for the read paths, verified live against the user's own authenticated session.

This is a very favourable target. The main engineering work is not access, it is **HTML → structured
JSON extraction** and **session lifecycle management**, both of which are exactly the things that
belong in code rather than in an agent's context window. Hence: MCP server.

No Backloggd MCP server exists yet on any registry. This would be the first.

---

## 2. Research findings

### 2.1 No official API

Confirmed across several sources:

- `robots.txt` labels `/api/*` verbatim as `# Internal API use` — the only API is the site's own.
- The public [roadmap](https://backloggd.com/roadmap/) has no API or developer-access item. The
  closest entries are consumer-facing import/export features (Steam import, CSV import/export).
- Monthly developer updates (Medium, checked Jan & Mar 2026) never mention public API, developer
  access, or third-party integrations. It is a solo, Patreon-funded project.
- There is **no private mobile API** either. The most popular "Backloggd Android app"
  (`wagenknecht/backloggd-android-app`, 78★, actively maintained) is a **WebView wrapper** around
  `backloggd.com` that scrapes HTML with Jsoup using the WebView's own session cookie. If a private
  JSON API existed, that app would be using it.

So: scraping the web app is the only option, and it is the option everyone else uses too.

### 2.2 Site architecture

| Aspect | Finding |
|---|---|
| Backend | Ruby on Rails, hosted on Render (`x-render-origin-server: Render`) |
| Front-end | Turbo (Hotwire) + Stimulus + heavy jQuery; server-rendered HTML, **no SPA/GraphQL** |
| CDN | BunnyCDN, with Bunny Shield active (`bunny_shield_id_*` cookie) but **not challenging** |
| Session | Rails encrypted cookie `_backloggd_session`, `secure; httponly; samesite=lax`, domain `.backloggd.com` |
| CSRF | Rails `authenticity_token`; `<meta name="csrf-token">` in every page |
| Canonical host | `backloggd.com` — `www.` 301-redirects to apex |
| Game IDs | Numeric, and appear to be **IGDB IDs** (Elden Ring = `119133`; covers served from `images.igdb.com`) |

The JS bundle (`https://static.backloggd.com/assets/application-*.js`, ~1.7 MB) contains **every**
AJAX call site as a plain string literal. Beautifying it and grepping `url: "…"` yields the complete
endpoint inventory in one pass — this is how the map below was built, and it is how it should be
re-derived whenever the bundle hash changes.

### 2.3 Authentication model

Two layers, both required for writes:

1. **Session** — cookie `_backloggd_session`. Obtainable two ways:
   - **Password login**: `GET /users/sign_in` to scrape the form's `authenticity_token`, then
     `POST /users/sign_in` with `authenticity_token`, `user[login]`, `user[password]`,
     `user[remember_me]=1`. Verified: wrong credentials return **HTTP 422** with an
     `alert-backloggd-error` block containing "Invalid … incorrect". Correct credentials set a fresh
     session cookie.
   - **Cookie reuse**: paste an existing `_backloggd_session` value, or import it from the local
     browser profile. Verified working end-to-end — the session extracted from this machine's Firefox
     profile authenticated successfully as user `Denision` (numeric id `181645`).
2. **CSRF** — every non-GET request needs `X-CSRF-Token`, read from `<meta name="csrf-token">` on any
   page fetched with the same session. **Verified enforced**: `POST /api/user/games/logs` returns
   **422 without** the header and **200 with** it. One token is valid for the whole session, so it can
   be fetched once and cached, with a re-fetch on 422.

The numeric `user_id` is needed for the full log-write endpoint. It is **not** on the profile page; it
is on `GET /settings/` as a `user_id="181645"` attribute. Fetch once at session start and cache.

### 2.4 Endpoint map

Everything below was extracted from the production JS bundle. Rows marked ✅ were additionally
executed live against a real authenticated session. Writes were deliberately **not** executed, to
avoid mutating the user's real account during research — their shapes come from reading the bundle's
call sites, corroborated by three independent third-party implementations.

**Read — JSON responses (the good stuff)**

| Purpose | Method & path | Notes |
|---|---|---|
| ✅ Game autocomplete | `GET /autocomplete.json?query=…` | Returns `{suggestions:[{value,data:{slug,title,year,id}}]}`. Fast, clean, no auth needed. |
| ✅ Your log state for a game | `GET /log/edit/{game_id}` | JSON: `{game_log:{id,status,rating,is_play,is_playing,is_backlog,is_wishlist,game_liked,total_hours,…}, playthroughs, most_recent_playthrough_id}` |
| ✅ Batch log state | `POST /api/user/games/logs` body `ids[]=…` | Returns a map of `game_id → {rating,is_play,is_backlog,is_liked,game_log_id,…}`. **Ideal for enriching search results in one round-trip.** |
| Playthrough detail | `GET /playthrough/{id}` | JSON `{playthrough:{…}}` |
| Library entries for a game | `GET /library/get/{game_id}` | Returns `{html_res}` — HTML fragment |

**Read — HTML/Turbo responses (need parsing)**

| Purpose | Method & path |
|---|---|
| ✅ Game page (metadata + your state) | `GET /games/{slug}/` |
| ✅ Search results | `GET /search/results/?query=…&type=games` with `Accept: text/vnd.turbo-stream.html` |
| ✅ Search page (fallback) | `GET /search/games/{query}/` |
| ✅ User library | `GET /u/{user}/games/`, `…/games/{sort}/{filters}/`, `?page=N` |
| ✅ Status shortcuts | `GET /u/{user}/{playing\|backlog\|wishlist}/` |
| ✅ Journal | `GET /u/{user}/journal/` |
| ✅ Lists index | `GET /u/{user}/lists/{recent\|created\|likes\|title}/` |
| List detail / edit | `GET /u/{user}/list/{slug}/`, `…/edit/` |
| ✅ Reviews (per game) | `GET /reviews/preview/{slug}/` → turbo-stream |
| ✅ Reviews (per user) | `GET /u/{user}/reviews/` |
| ✅ Profile | `GET /u/{user}/` |
| ✅ Browse / discover | `GET /games/lib/{popular\|rating\|release\|trending\|title}/`, `?page=N` |
| Filtered browse | `POST /games/render/` body `filters[…]` (categories, genres, platforms, rating range, year) |
| ✅ Settings (source of `user_id`) | `GET /settings/` |

**Write**

| Purpose | Method & path | Body |
|---|---|---|
| Toggle status | `POST /log/` | `type=play\|playing\|backlog\|wishlist`, `game_id` |
| Set played sub-status | `PATCH /log/status/` | `game_id`, `status_id` |
| Rate | `POST /rate/{game_id}` | `rating` (1–10 = half-stars; 10 = 5★) |
| Remove rating | `DELETE /delete-rating/{game_log_id}` | — |
| **Full log / review save** | `POST /api/user/{user_id}/log/{game_id}` | `game_id`, `playthroughs[]`, `dates{}`, `log{}`, `deleted_playthroughs`, `deleted_dates`, `deleted_library_entries`, `modal_type=full\|quick` |
| Related-game log | `POST /api/user/{user_id}/log/related/{game_id}` | `log{}`, `parent_log_id` |
| Delete playthrough | `DELETE /playthrough/{id}` | — |
| **Wipe game from library** | `DELETE /unlog/` | `game_id`, `log_id` — destructive: kills logs, review, rating, time |
| Like / unlike game | `POST /like/game/{id}` · `DELETE /unlike/game/{id}` | — |
| Add to lists (bulk) | `POST /api/list/quick/{game_id}` | `to_add_ids[]`, `to_remove_ids[]` |
| Create list | `POST /api/new-list/` | — |
| Add game to list | `POST /api/list/{list_id}/{game_id}` | `grid_mode` |
| Reorder / edit entries | `PUT /api/list/{list_id}/update-entries-2/` | form or JSON body |
| Discard list changes | `PATCH /api/list/{list_id}/discard-entries/` | — |
| Follow / unfollow | `POST /follow/` · `DELETE /unfollow/` | `user_id` |
| Like review/list | `POST /like/{model}/{id}` · `DELETE /unlike/{model}/{id}` | — |
| Comment | `POST /comment/` · `/comment/edit/` · `/comment/destroy/` | — |
| Add favourite game | `POST /add-favorite/{game_id}/` | — |

The `log{}` object accepted by the full-log endpoint (from the bundle's `kc()` function plus the
2025-era param set used by `DanteCampos/Backloggd-Import`) covers: `status`, `rating`, `review`,
`review_spoilers`, `is_play`, `is_playing`, `is_backlog`, `is_wishlist`, `game_liked`, `is_replay`,
`is_master`, `played_platform`, `edition_id`, `storefront_id`, `medium_id`, `hours_played`,
`mins_played`, `hours_finished`, `mins_finished`, `sync_sessions`, `override_cover_id`,
`start_date` / `finish_date` (via the `dates{}` map).

### 2.5 Bot protection and rate limits

Directly probed:

- **User-agent filtering: none.** `python-requests`, `curl/8.4.0`, `node-fetch`, a literal
  `ClaudeBot` UA, and *no UA at all* all returned **200**. Bunny Shield sets a cookie but issues no
  challenge, no JS puzzle, no CAPTCHA.
- **Read rate limiting: not observed.** 12 rapid-fire `autocomplete.json` requests all returned 200.
- **Write rate limiting: real, and per-action.** The bundle has explicit 429 handlers with distinct
  messages — *"You are following users too quickly"*, *"You are liking reviews too quickly"*.
  Third-party bulk importers hit 429 on log writes and back off 180 s.
- **A documented gotcha did not reproduce.** `Medpus/BackloggdExporter` warns that any path under
  `/u/{user}/games/…` returns 403 and only a bare `…/games` works. Tested all five variants against
  this session: every one returned **200**, including trailing slash, sort segments, and filter
  segments. Treat it as transient or region-specific, but keep a 403 retry path.
- **The user's own connection to Backloggd is unreliable** — identical requests either complete in
  <0.5 s or hang indefinitely with zero bytes. This is a network/CDN-path issue, not server
  behaviour. **The client must treat stalls as retryable**, using a stall detector (bytes/sec floor)
  rather than only a total timeout, since a naive timeout will misdiagnose a working endpoint as
  broken.

### 2.6 Prior art

| Project | Lang | ★ | Last push | Value |
|---|---|---|---|---|
| `BearTS/backloggd-go` | Go | 0 | 2024-06 | Most complete **write** SDK. Full endpoint map, login flow, selectors, pagination. Stale but the best reference. |
| `DanteCampos/Backloggd-Import` | Python | 3 | 2025-12 | Newest write param schema; documents the `/log/edit/` → `DELETE /unlog/` delete flow. |
| `tapioca2k/Backloggd-csv-importer` | Python | 10 | 2025-12 | Confirms IGDB↔Backloggd ID equivalence; 429 backoff handling. |
| `Medpus/BackloggdExporter` | Python | 7 | 2026-06 | Best **read** scraper. Pagination termination trick, 403 handling. |
| `Qewertyy/Backloggd-API` | TS | 18 | 2026-07 | Most-starred; read-only profile scraping with cheerio. |
| `luisgbr1el/backloggd-wrapper` | TS/npm | 0 | 2026-07 | Only npm package; read-only profile/reviews. |

**No MCP server exists.** Verified empty on glama.ai (of ~70 k servers), smithery.ai, pulsemcp.com,
mcp.so, npm, and PyPI.

Two useful selector conventions everyone converged on, worth reusing:

- Star ratings are encoded as an inline width percentage: `.stars-top[style="width:N%"]` → `N/20`
  gives the 5-star value. There is no numeric attribute.
- Game cards are `.card.game-cover` carrying a `game_id` attribute; the title is in
  `.game-text-centered` or the `img[alt]`.

### 2.7 robots.txt and terms — an honest reading

`robots.txt` disallows, for `User-agent: *`, precisely the paths this project needs: `/api/*`,
`/u/*/games/*`, `/u/*/logs/*`, `/lists/*`, `/games/*/*/`. It separately blocks `ClaudeBot`,
`anthropic-ai`, `Claude-Web`, `GPTBot`, `CCBot` and friends from the entire site via a Dark Visitors
managed list. No public ToS page was found (`/terms/` 404s; only `/about/privacy/` exists).

That directive is aimed at **crawlers and AI training scrapers**, and this tool is neither: it is a
user-driven client, authenticated as the user, doing things the user could do by hand in their own
browser — the same posture as the WebView Android app or a browser extension. That reading is
reasonable, but it is a *reading*, and the operator's intent to limit automated traffic is
unambiguous. The design should honour the spirit of it rather than lawyer the letter:

- Send a **truthful, identifiable** User-Agent naming the tool and its repo. Do not impersonate a
  browser, and do not attempt to evade Bunny Shield if it ever starts challenging.
- **Serialise requests** and rate-limit client-side. Never parallel-crawl.
- **Cache aggressively** so repeat questions cost zero requests.
- Operate **only on the authenticated user's own data and pages they can already see**. No bulk
  harvesting of the public catalogue, no building a mirror.
- Document all of this in the README so users understand what the tool does on their behalf.

If Backloggd ever ships an official API or asks that this stop, the project should switch or retire.

---

## 3. MCP server vs. skill — the call

**Build an MCP server.** A skill is the wrong shape here, for four concrete reasons:

1. **Stateful auth doesn't fit in prose.** The flow is: acquire session → fetch a page → parse the
   CSRF meta tag → cache it → fetch `/settings/` → parse `user_id` → cache it → detect 422 → refresh
   the token → detect session expiry → re-login. A skill would make the agent re-derive that chain
   every session, with a fresh chance to get it wrong each time. In code it is written once and
   tested.
2. **Context economy.** A single user-library page is **250 KB of HTML**; the game page is 99 KB. A
   skill-driven agent would pull that raw into context to answer "what did I rate Elden Ring?".
   The MCP answers it from `GET /log/edit/119133` — **~250 bytes of JSON**. That is a three-orders-of-
   magnitude difference on a routine question, and the gap compounds across a conversation.
3. **Writes need a typed contract.** Ratings are 1–10 half-star integers, not 0–5 floats. Status is a
   `status_id` enum. The full-log endpoint takes a nested object with ~20 fields and several
   `deleted_*` arrays. These mutate the user's real account, and `DELETE /unlog/` is irreversible.
   A JSON Schema that rejects a malformed rating before it is sent is a materially better safety
   story than an instruction paragraph that hopes the agent remembers the scale.
4. **Reuse and testability.** An MCP server works in Claude Desktop, Claude Code, and any other MCP
   client, and its parsers can have a regression suite pinned against saved HTML fixtures — which
   matters a lot, because these selectors *will* break when the site redeploys.

The genuinely skill-shaped part is *workflow guidance* ("when the user says they finished a game, set
status to played, ask for a rating, offer to log dates"). That is a thin optional layer to add later,
on top of the server — not a replacement for it.

---

## 4. Technology choices

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node ≥ 20) | Typed tool schemas are the core safety mechanism; the domain model is large enough that types earn their keep. |
| Distribution | **`npx backloggd-mcp`** | Zero-install for anyone with Node, which is the common denominator for MCP clients. `uvx` would require users to have `uv`. |
| MCP SDK | `@modelcontextprotocol/sdk` | Reference implementation, stdio transport. |
| HTTP | `undici` | Native-ish, fast, supports per-request timeouts and a custom dispatcher for retry/stall logic. |
| Cookies | `tough-cookie` | Correct domain/path/secure semantics; serialisable jar for persistence. |
| HTML parsing | `cheerio` | jQuery-shaped selectors against a jQuery-shaped site; matches every prior-art project. |
| Validation | `zod` | Schema per tool, auto-derived JSON Schema for MCP. |
| Testing | `vitest` + saved HTML fixtures | Parser regressions are the top maintenance risk; fixtures make breakage loud and cheap to fix. |
| Config | env vars + optional cookie file | See §6. |

Python/`uvx` is a perfectly viable alternative and would cost little to switch to; the deciding factor
is `npx` reach.

---

## 5. Architecture

```
src/
  index.ts              # stdio server bootstrap, tool registration
  config.ts             # env parsing, auth-mode resolution
  http/
    client.ts           # undici wrapper: cookie jar, UA, serialised queue,
                        #   stall-aware retry, 429 backoff, 422 CSRF refresh
    ratelimit.ts        # token bucket; stricter bucket for writes
  auth/
    session.ts          # login | cookie | browser-import; session probe & refresh
    csrf.ts             # meta-tag token cache + invalidation
    browser-import.ts   # read _backloggd_session from local Firefox/Chrome profile
  api/
    games.ts  library.ts  logs.ts  lists.ts  reviews.ts  social.ts
                        # one module per domain; endpoints only, no MCP concerns
  parse/
    game-page.ts  game-card.ts  library.ts  lists.ts  reviews.ts
    journal.ts  profile.ts  pagination.ts  stars.ts
  tools/                # MCP tool defs: zod schema + handler + description
  types.ts
  cache.ts              # TTL cache: slug→id forever, metadata 24 h, user state 30 s
test/fixtures/*.html    # saved pages; parser regression suite
```

**Design rules**

- **Parsers are pure functions** `(html: string) => T`. No network inside a parser. This is what
  makes the fixture suite possible.
- **Every parser degrades gracefully.** A missing optional field yields `null` and a structured
  warning, never a throw. One changed CSS class must not take the whole tool down.
- **All requests funnel through one client** so retry, rate limiting, cookie handling, and CSRF
  refresh exist in exactly one place.
- **Prefer JSON endpoints over HTML** wherever both exist. In particular, resolve user state through
  `/log/edit/{id}` and `POST /api/user/games/logs` rather than scraping library pages.
- **Resolve slug → numeric id once and cache forever** (`autocomplete.json` is the cheapest resolver).
  IDs are stable; slugs occasionally change on merges.

**Reliability, given the flaky connection.** The HTTP client must distinguish three failure modes and
handle each: a *stall* (connection open, no bytes — retry with backoff, this is the user's common
case), a *429* (respect `Retry-After`, else exponential backoff from 5 s, and surface a clear message
rather than silently sleeping 180 s), and a *422* (refresh CSRF once, retry once, then fail loudly).
Default to ~5 attempts with jitter. This is not gold-plating: it is the single biggest determinant of
whether the tool feels reliable on this network.

---

## 6. Authentication & configuration

Three modes, resolved in this order:

1. `BACKLOGGD_SESSION` — a `_backloggd_session` cookie value. Simplest, no password ever touches the
   tool. Dies when the session expires.
2. `BACKLOGGD_USERNAME` + `BACKLOGGD_PASSWORD` — full login flow; auto re-login on session expiry.
   The durable option.
3. `BACKLOGGD_BROWSER_IMPORT=firefox|chrome` — lift the live session from the local browser profile.
   Best DX for a local-only tool; **verified working** during this research against Firefox
   (`sessionstore-backups/recovery.jsonlz4`, mozLz4 frame + LZ4 block decode; the cookie lives in the
   session store, not `cookies.sqlite`, because it is a browser-session cookie).

The resolved session is persisted to `~/.backloggd-mcp/session.json` (mode `0600`) so restarts don't
re-authenticate. Credentials are never logged; the session value is redacted in all error output.

Also worth supporting: `BACKLOGGD_READONLY=1` to hard-disable every write tool. Useful for anyone who
wants the search/library half without granting mutation rights.

Example client config:

```json
{
  "mcpServers": {
    "backloggd": {
      "command": "npx",
      "args": ["-y", "backloggd-mcp"],
      "env": { "BACKLOGGD_BROWSER_IMPORT": "firefox" }
    }
  }
}
```

---

## 7. Tool surface

Grouped, ~24 tools. Names are stable identifiers; descriptions in the server should state units and
enums explicitly (especially the rating scale, the single most likely thing to get wrong).

**Session**
- `backloggd_whoami` — auth status, username, numeric id, read-only flag.

**Search & discovery**
- `search_games` — query → id, slug, title, year, platforms, category. Optionally enriches each hit
  with the caller's own status/rating via the batch endpoint, in one extra round-trip.
- `get_game` — full metadata for a slug/id: title, year, cover, description, genres, platforms,
  developers/publishers, average rating and rating count, plus *your* status, rating, review, and
  playtime when authenticated.
- `browse_games` — the discovery surface: sort (`popular`/`rating`/`release`/`trending`/`title`),
  filters (genre, platform, year range, rating range, category), paginated.
- `get_game_reviews` — community reviews for a game, paginated.

**Your library (read)**
- `get_my_library` — paginated, filterable by status/platform/rating, sortable. Returns
  `{game, status, rating, playtime, dates}` rows.
- `get_game_log` — your detailed log(s) for one game, including every playthrough.
- `get_journal` — chronological play journal.
- `get_my_stats` — profile aggregates.

**Status, rating, likes (write)**
- `set_game_status` — `played | playing | backlog | wishlist | none`, plus optional played sub-status
  (completed, retired, shelved, abandoned).
- `rate_game` — accepts **0.5–5.0 in half-star steps**, converts to the wire's 1–10 internally so the
  caller never sees the internal scale.
- `remove_rating`
- `set_game_like` — like/unlike.

**Logs & reviews (write)**
- `create_or_update_log` — the workhorse: rating, review text, spoiler flag, platform, storefront,
  start/finish dates, hours played, replay and mastered flags, status. Wraps
  `POST /api/user/{user_id}/log/{game_id}`.
- `delete_log` — one playthrough.
- `remove_game_from_library` — wraps `DELETE /unlog/`. **Irreversible and wide-blast-radius** (logs,
  review, rating, playtime, like all die). Requires an explicit `confirm: true` argument, and its
  description must say plainly what is destroyed.

**Lists**
- `get_lists` — a user's lists.
- `get_list` — one list's entries, paginated.
- `create_list` — name, description, privacy.
- `add_games_to_lists` / `remove_games_from_lists` — bulk, via `/api/list/quick/{game_id}`.
- `update_list` — rename, re-describe, reorder.

**Social**
- `get_user_profile` — public profile, favourites, stats.
- `get_user_reviews`
- `set_follow` — follow/unfollow.
- `like_review`

**Response conventions.** Tools return compact JSON, never raw HTML. Lists paginate with an explicit
`{items, page, has_more, total?}` envelope and default to modest page sizes so a single call can't
flood the context. Every response carries the canonical `backloggd.com` URL for the entity so the
agent can cite something clickable.

---

## 8. Implementation phases

**Phase 1 — Foundation.** Repo scaffold, `undici` client with the stall/429/422 retry logic, cookie
jar, all three auth modes, CSRF and `user_id` caching, `backloggd_whoami`. *Exit criterion:*
authenticate three ways and confirm identity against a live session.

**Phase 2 — Read: games.** `search_games`, `get_game`, `browse_games`, plus the parser fixture
harness. *Exit criterion:* metadata extraction verified against ≥20 diverse games (DLC, bundles,
unreleased, unrated, merged).

**Phase 3 — Read: user data.** `get_my_library` with pagination, `get_game_log`, `get_journal`,
`get_my_stats`, `get_user_profile`. Pagination must handle Backloggd's habit of re-serving the last
page forever — terminate on a repeated id set, as `Medpus` does, not on an empty page.

**Phase 4 — Write: the simple ones.** `set_game_status`, `rate_game`, `remove_rating`,
`set_game_like`. **This is the first phase that mutates a real account**, so it starts against a
throwaway test account, and every write is verified by reading the state back.

**Phase 5 — Write: logs & reviews.** `create_or_update_log`, `delete_log`,
`remove_game_from_library`. The nested payload here is the fiddliest part of the project; build it by
capturing a real browser save from DevTools and replaying it field-for-field before generalising.

**Phase 6 — Lists & social.** Remaining tools.

**Phase 7 — Ship.** README (including the honest automation-posture note from §2.7), npm publish,
registry submissions (glama, smithery, pulsemcp), and a `--selftest` flag that exercises every read
parser against live pages so breakage after a Backloggd redeploy is one command away from diagnosis.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Selector breakage on redeploy** | High — the top ongoing cost | Pure parsers + fixture suite + graceful per-field degradation + `--selftest`. Re-derive the endpoint map by grepping the new JS bundle. |
| Flaky network to Backloggd | Certain, for this user | Stall-aware retry is a Phase-1 requirement, not a polish item. |
| Write payload shape wrong | Medium | Replay a captured browser request before generalising; verify by read-back; test account first. |
| 429 on bulk writes | Medium | Client-side write bucket, `Retry-After` handling, clear surfaced errors instead of silent long sleeps. |
| Session expiry mid-session | Medium | Detect the login redirect, re-authenticate transparently when password mode is configured; otherwise fail with an actionable message. |
| Bunny Shield starts challenging | Low | Fail with a clear explanation. **Do not build evasion.** |
| Operator objects to the tool | Low | Honest UA, conservative rate, documented posture; switch to an official API or retire if asked. |
| Destructive tool misfires | Low, high impact | `confirm: true` on `remove_game_from_library`; `BACKLOGGD_READONLY`; blunt descriptions. |

---

## 10. Open questions for implementation

**Resolved during the build** (2026-08-11):

- ~~**`status_id` enum values.**~~ Read off `#quick-play-type-modal .play-type-option`:
  `completed=0`, `abandoned=2`, `retired=3`, `shelved=4`, `played=5`. They are neither sequential
  nor in menu order, and the obvious guess maps "completed" onto "abandoned" — pinned by a test
  against the fixture so it cannot regress.
- ~~**Create-list payload.**~~ `POST /api/new-list/` takes a flat `{type, title, year}`, *not* the
  Rails `list[...]` nesting the form's own inputs imply. `type` is `unranked | ranked | goty`;
  `year` only applies to `goty`. Responds with `{new_url}`.
- ~~**Array parameters.**~~ Rails needs repeated `ids[]=1&ids[]=2`. Indexed keys (`ids[0]=`) arrive
  as a hash and the controller returns 500.

**Still open:**

1. **IGDB ID equivalence.** Backloggd ids look exactly like IGDB ids (Elden Ring `119133`, covers from
   `images.igdb.com`), and `tapioca2k` relies on this. Confirm it, and if it holds, optional IGDB
   enrichment becomes nearly free — but keep it opt-in behind a user-supplied IGDB key, never a hard
   dependency.
2. **Platform / storefront / edition id tables.** Available from `/platforms/fetch/all/` and
   `/genres/fetch/all/`; fetch once and cache, or vendor as static data. Until then `log_game`
   leaves platform unset.
3. **Review length and formatting limits.** Unknown; discover empirically.
4. **Private-profile behaviour.** How the site responds when reading another user's private data —
   determines the error path for `get_user_profile`.
5. **Write-path verification.** Every write endpoint is implemented from the front-end bundle's own
   call sites but has **not been executed** — by deliberate constraint, nothing was written to a
   real account during development. Each one needs a first run against a throwaway test account,
   verified by reading state back.

---

## Appendix — reproducing the research

```bash
# 1. Pull the front-end bundle and enumerate every AJAX call site
curl -s https://static.backloggd.com/assets/application-<hash>.js -o app.js
npx -y js-beautify app.js -o app.pretty.js
grep -oE 'url: *"[^"]*"' app.pretty.js | sort | uniq -c | sort -rn
```

```bash
# 2. Verify an authenticated session (cookie jar in Netscape format)
curl -s --compressed -b cookies.txt https://backloggd.com/log/edit/119133
```

The `<hash>` in the bundle filename changes on every deploy; read the current one from the
`<link rel="preload">` header on any page. Re-running step 1 after a redeploy is the fastest way to
detect endpoint changes.

Requests to Backloggd should use stall detection, because a plain timeout misreads this network:

```bash
curl -sS --compressed --connect-timeout 10 --speed-time 25 --speed-limit 50 \
     --retry 5 --retry-all-errors --retry-delay 2 --max-time 90 "$URL"
```
