# backloggd-mcp

An MCP server for [Backloggd](https://backloggd.com), the video game tracker. It lets an AI
assistant search the game catalogue and read and manage **your** library — statuses, ratings,
logs, play sessions, reviews and lists — as the signed-in you.

Beyond plain CRUD it exposes the parts of Backloggd that make it a *backlog* tool: filtering
your library by release platform, genre or year, sorting by how long games take to finish,
browsing a studio's whole catalogue with your own status attached, and checking a pile of
titles against your shelves and lists in one call.

Backloggd has no public API, so this drives the same endpoints the website's own front end
uses. See [Automation posture](#automation-posture) for what that means and how this server
tries to be a good citizen about it.

> **Unofficial.** Not affiliated with or endorsed by Backloggd.

## Install

Nothing to install — point your MCP client at `npx`:

Requires Node 20+. Not on npm yet, so install straight from GitHub — the package builds
itself on install via its `prepare` script.

**Claude Code** — `claude mcp add` picks up your shell environment, so this is enough:

```bash
claude mcp add backloggd -s user -e BACKLOGGD_BROWSER_IMPORT=firefox -- npx -y github:DenisionSoft/backloggd-mcp
```

**Claude Desktop** — edit `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "backloggd": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "github:DenisionSoft/backloggd-mcp"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "BACKLOGGD_BROWSER_IMPORT": "firefox"
      }
    }
  }
}
```

The absolute command path and the explicit `PATH` are both required, and this is the single
most common reason a Desktop MCP server silently fails to start: Desktop is a GUI app and
does **not** inherit your shell environment, so a bare `"command": "npx"` cannot be found,
and even an absolute `npx` dies with `env: node: No such file or directory` because its
shebang cannot locate node. Adjust the paths if node lives somewhere other than Homebrew
(`which node` will tell you). `git` must be reachable too — npx clones the repo to install it.

### Pinning to a local checkout instead

Installing from a git ref re-resolves against GitHub on every server start (~2s warm, and it
blocks rather than falling back to cache if GitHub is unreachable). If you would rather have
an instant, offline-capable start — or you are actively editing the code — clone it and point
at the build:

```bash
git clone https://github.com/DenisionSoft/backloggd-mcp && cd backloggd-mcp && npm install
```

then use `"command": "node", "args": ["/absolute/path/to/backloggd-mcp/dist/index.js"]`. That
starts in ~250ms and needs no network to launch, but it runs whatever is in `dist/` — you must
`npm run build` to pick up changes.

## Authentication

Pick one. They are resolved in this order.

| Method | Env vars | Notes |
| --- | --- | --- |
| Session cookie | `BACKLOGGD_SESSION` | The `_backloggd_session` value from your browser's DevTools. No password ever reaches this server. Stops working when the session expires. |
| Username + password | `BACKLOGGD_USERNAME`, `BACKLOGGD_PASSWORD` | The durable option — the server renews the session itself when it lapses. |
| Import from browser | `BACKLOGGD_BROWSER_IMPORT=firefox` | Lifts the live session straight out of your local Firefox profile. Best for a local-only setup. Chrome is not supported: its cookie store is encrypted with an OS-keychain key that this server deliberately does not touch. |

The resolved session is cached in `~/.backloggd-mcp/session.json` (mode `0600`) so restarts do
not re-authenticate. The cache is keyed to a hash of the credentials that produced it, so
changing `BACKLOGGD_SESSION` or switching accounts never silently keeps you signed in as the
previous one. Credentials are redacted from all log output, and no tool ever returns the
session cookie.

### Auth is a setup step, not something the assistant does

An MCP server receives its environment from your client's config at launch, so an assistant
cannot obtain or change credentials for a running server. You configure this once; the
assistant just uses it. Nothing needs to teach it how — when credentials are missing or
stale, the tools return a message naming the exact variable to set.

What differs between the modes is what happens when a session eventually lapses:

| Mode | On expiry |
| --- | --- |
| `BACKLOGGD_BROWSER_IMPORT` | **Self-healing**, as long as you are still logged in to Backloggd in that browser. The server re-imports the fresh session automatically. |
| `BACKLOGGD_USERNAME` + `BACKLOGGD_PASSWORD` | **Self-healing.** The server logs in again by itself. |
| `BACKLOGGD_SESSION` | **Needs you.** The assistant will report that the cookie expired and ask for a fresh one; it cannot fetch it. |

For a local setup, browser import is the least-effort option: nothing to paste, and it
recovers on its own.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKLOGGD_READONLY` | off | Do not even register the write tools. |
| `BACKLOGGD_MIN_REQUEST_INTERVAL_MS` | `700` | Floor on the gap between any two requests. |
| `BACKLOGGD_MIN_WRITE_INTERVAL_MS` | `2500` | Floor on the gap between two writes. |
| `BACKLOGGD_MAX_WRITES_PER_MINUTE` | `12` | Per-minute write budget. |
| `BACKLOGGD_MAX_WRITES_PER_HOUR` | `200` | Per-hour write budget. |
| `BACKLOGGD_REQUEST_TIMEOUT_MS` | `45000` | Per-request ceiling. |
| `BACKLOGGD_MAX_RETRIES` | `5` | Retries for stalls and transient failures. |
| `BACKLOGGD_STATE_PATH` | `~/.backloggd-mcp/session.json` | Where the session is cached. |
| `BACKLOGGD_DEBUG` | off | Request diagnostics on stderr (never credentials). |

## Tools

**Read (26).** `backloggd_whoami`, `search_games`, `get_game`, `get_my_game_log`,
`check_games`, `get_game_lists`, `query_library`, `export_library`, `browse_games`,
`browse_company`, `get_related_games`, `get_games_metadata`, `find_in_collection`,
`get_play_sessions`, `get_journal`, `get_lists`, `get_list`, `get_game_reviews`,
`get_user_reviews`, `get_user_profile`, `get_game_logs`, `get_activity`, `get_follows`,
`get_notifications`, `search_users`, `list_filter_values`.

**Write (13).** `set_game_status`, `set_played_status`, `rate_game`, `set_game_like`,
`log_game`, `log_play_session`, `add_game_to_lists`, `create_list`, `reorder_list`,
`add_favorite_game`, `save_review_draft`, `set_follow_user`, `like_review`.

**Gated (6).** `remove_rating`, `delete_playthrough`, `remove_game_from_library`,
`delete_list`, `delete_comment`, `post_comment` — all behind the confirmation flow below.
`post_comment` is gated not because it deletes anything but because it publishes publicly
under your name.

### The ones worth knowing about

**`query_library`** is the main one. Backloggd's library URLs are a filter grammar, and this
exposes all of it: shelf, completion status, **release platform**, genre, year, rating and
category, sorted by anything including `avg-finish-time` (shortest games first) and `shuffle`.

```
query_library(shelf: "backlog", sort: "avg-finish-time")     → what can I actually finish?
query_library(shelf: "backlog", release_platform: "PS5")     → what do I own that runs on PS5?
query_library(shelf: "backlog", release_platform: "Wii U")   → what would I have to emulate?
```

Platform and genre accept plain names — "PS5", "Meta Quest 3", "RPG" — and are validated
against the real vocabularies before the request goes out. That matters because Backloggd
answers an unrecognised slug with an HTTP 500, so a typo would otherwise surface as an opaque
server error. It also means an empty result is trustworthy: nothing matched, rather than the
query being malformed.

**`browse_company`** returns a developer's or publisher's whole catalogue with *your* shelf
state attached to every game, 60 per request. Good for "which FromSoftware games haven't I
played", and for franchise gap-hunting.

**`check_games`** takes a pile of titles and reports, per game, the shelf, rating and which of
your custom lists contain it.

**`find_in_collection`** searches shelves *and* every custom list at once — necessary because
Backloggd's list pages ignore the filter grammar entirely.

**`get_games_metadata`** costs one request per game, and says so. Prefer `query_library` when
the set is really a library query; use this for list contents, which cannot be filtered
server-side.

Ratings are always on the **0.5–5 star scale** shown on the site. Backloggd stores them
internally as 1–10; that conversion happens inside the server and never leaks into a tool
argument.

## Safety

Deleting things on Backloggd is permanent — the site offers no undo — so the destructive
tools use a two-phase confirmation rather than a `confirm: true` flag, which a model can
simply set for itself.

The first call **cannot perform the action at all**. It reads back exactly what would be
destroyed and returns that inventory together with a server-generated token:

```jsonc
{
  "status": "confirmation_required",
  "summary": "Permanently delete ALL of your Backloggd data for \"Elden Ring\". This cannot be undone.",
  "willBeDeleted": {
    "shelf": "backlog",
    "rating": 4.5,
    "playthroughCount": 2,
    "playthroughs": [{ "id": 881, "hasReview": true, "reviewPreview": "One of the best…" }]
  },
  "preserved": "Nothing is preserved. The game is removed from your account entirely.",
  "confirmation_token": "confirm_96701e1ab900c8a7db6f1c2e"
}
```

Only a second call carrying that exact token proceeds. The token is random, single-use,
short-lived, and bound to the specific action *and* game — one minted for deleting a rating
cannot be replayed to delete a library entry, and one minted for game A cannot be used on
game B. Because it cannot be guessed or constructed, the only route to a successful delete
runs through that preview being surfaced in the conversation, which is the point: you get to
see what is about to be destroyed before it happens.

Other protections:

- **Toggle-safety.** Backloggd's `/log/` endpoint is a *toggle*, not a setter — posting
  `backlog` for a game already on the backlog silently removes it. `set_game_status` always
  reads current state first and sends only the changes that are actually needed.
- **Shelf preservation.** `log_game` carries forward shelves and flags you did not mention,
  so writing a review can never quietly move a game off your backlog.
- **Read-only mode.** `BACKLOGGD_READONLY=1` means the write tools are never registered, so
  they cannot be called at all.
- **Session preservation.** `log_play_session` re-sends the playthrough's existing sessions
  alongside the new one, because the save endpoint replaces the set rather than appending to
  it — omitting them would silently delete your play history for that game.
- **Filter validation.** Platform, genre and category values are checked against the real
  vocabularies before any request is made, so a typo becomes a "did you mean" instead of an
  HTTP 500.

## Automation posture

Backloggd's `robots.txt` targets crawlers and AI training scrapers, and disallows several of
the paths this server uses. This tool is not a crawler: it acts only as the signed-in user,
on that user's own data, doing things they could do by hand in their browser — the same
posture as a browser extension or the community WebView mobile app. That is a considered
reading, but the operator's wish to limit automated traffic is clear, so the server is built
to honour the spirit of it:

- It sends an **honest, identifiable User-Agent** naming the tool and this repo. It does not
  impersonate a browser.
- **Requests are serialised** — never parallel — with a floor on the gap between them, and a
  much stricter budget on writes.
- A **circuit breaker** stops all traffic for 15 minutes after repeated `429`s. Hammering an
  endpoint that is already rate-limiting you is what escalates into a restricted account.
- Responses are **cached** so repeat questions cost zero requests.
- It only reads your own data and pages you can already see. It does not bulk-harvest the
  public catalogue.
- If Backloggd ever puts up a bot challenge, the server **fails with a clear message rather
  than trying to evade it**.

Backloggd is a small, Patreon-funded site run by one person. Please do not raise the rate
limits just because you can. If you are the operator and would like this to change or stop,
open an issue.

## Maintenance

Backloggd's markup will change eventually. When something starts returning empty results:

```bash
npx backloggd-mcp --selftest
```

This exercises every read path against the live site and reports which ones broke. It runs
reads only and never touches a write endpoint.

To re-derive the endpoint map after a Backloggd redeploy, the front-end bundle contains every
AJAX call site as a plain string literal:

```bash
curl -s https://static.backloggd.com/assets/application-<hash>.js | npx js-beautify | grep -oE 'url: *"[^"]*"' | sort -u
```

The `<hash>` changes each deploy; read the current one from the `<link rel="preload">` tag on
any page.

## Development

```bash
npm install && npm run build && npm test
```

Parsers are pure `(html) => T` functions tested against saved HTML fixtures in
`test/fixtures/`, so a markup change fails loudly and locally instead of silently in a chat.
No test in the suite performs a network request or a write.

The fixtures are real pages captured from a signed-in session, then sanitised before being
committed:

- CSRF and authenticity tokens replaced with a placeholder;
- pages carrying private account settings not kept at all;
- **third parties anonymised** — other users' names, numeric ids, avatar URLs and review
  prose are replaced with synthetic stand-ins, since those people did not agree to appear in
  this repository. The parsers only care about structure, so nothing is lost.

Refresh a fixture by saving the equivalent page, then run `node scripts/anonymize-fixtures.mjs
<your-username>` before committing it.

## License

MIT
