# Feature research: what the current tools can't do

**Date:** 2026-08-11
**Status:** research only — nothing implemented, no writes performed
**Method:** re-derived the endpoint map from the current JS bundle (`application-a0cf4be3.js`,
unchanged since the first pass), then probed read endpoints against the live site with the
authenticated session. Write shapes were read out of the bundle's own call sites and **not
executed**.

---

> **Part 1** surveys the API surface for unexposed capability. **Part 2** works backwards from
> eight concrete user questions and checks whether the tools — current or proposed — can
> actually answer them. Part 2 changed Part 1: it caught that I had proposed the wrong platform
> filter.

## Summary

The current 26 tools cover the obvious CRUD surface, but they treat Backloggd as a
game-status database. What the site actually offers — and what a *backlog manager* is for —
is richer in five ways the tools do not reach:

1. **The library query language.** `get_library` exposes a shelf and a sort string. Backloggd
   supports a real filter grammar with a dozen dimensions, including *sort by how long a game
   takes to finish* and *shuffle*. This is the single biggest gap: it turns "list my backlog"
   into "what's a short RPG I already own on Switch".
2. **Community playtime and rating distribution.** Both are on every game page and neither is
   parsed. Playtime is what makes "what can I finish this weekend" answerable at all.
3. **Play sessions.** Backloggd has dated play sessions with notes, hours and tags — a whole
   journaling feature the server ignores.
4. **Taxonomy browsing.** Company catalogues and per-game series/DLC sections are whole
   navigable surfaces the server ignores — and company pages return your own shelf state
   inline, so "which FromSoftware games haven't I played" is one request.
5. **The read-only social/account surface.** Notifications, friends' activity, followers, a
   per-game log history, and yearly stats all exist and are unexposed.

Ranked proposals follow. Each says what it enables, what it costs, and how confident I am in
the endpoint.

---

## P1 — Rich library querying (`query_library`)

**The gap.** `get_library` takes `status` + a raw `sort` string. Backloggd's library URLs are
a filter grammar, and the useful dimensions are invisible to a caller who does not already
know them.

**What I confirmed.** Filters are `key:value` pairs, several joined by `;` inside one path
segment, with the sort as its own segment:

```
/u/{user}/games/{sort}[:asc|:desc]/{key:value;key:value}/?page=N
```

Filter keys, from the site's own generated links **and its filter sidebar** (`#filter-sidebar`,
which posts `filters[...]` and builds exactly this URL grammar):

| Key | Values |
| --- | --- |
| `type` | `played`, `playing`, `backlog`, `wishlist` |
| `game_status` | `completed`, `retired`, `shelved`, `abandoned`, `played` |
| **`release_platform`** | **platform slug — what the game released on** (`ps5`, `wiiu`, `meta-quest-3`, …) |
| **`genre`** | **genre slug** (`simulator`, `role-playing-rpg`, `shooter`, … — 23 total) |
| **`release_year`** | **four-digit year, or `upcoming` / `released`** |
| `played_platform` | platform slug — what *you* played it on (empty for unplayed games) |
| `played_year` | four-digit year |
| `rating` | `1`–`10` (wire half-stars) |
| `categories` | `games`, `extras`, `all` |
| `category` | `main_game`, `dlc`, `remake`, `remaster`, `port`, `bundle`, `mod`, `fork`, `expanded_game`, `standalone_expansion`, `episode`, `season`, `expansion`, `update` |

The three bolded keys are the important late addition — I originally only spotted
`played_platform`, which is nearly useless for a backlog (unplayed games have no *played*
platform, and `type:backlog;played_platform:win` duly returns zero). `release_platform` is the
one that answers "what in my backlog runs on a PS5", and it works.

Sorts: `added`, `title`, `release`, `rating` (community), `user-rating` (yours), `popular`,
`trending`, `last_played`, `time`, **`avg-play-time`**, **`avg-finish-time`**, **`shuffle`**.

**Why it matters.** Three of those sorts unlock questions that are currently unanswerable:

- `avg-finish-time` + `type:backlog` → *"what's the shortest thing in my backlog?"* This is
  the defining question of a backlog tool and it is one URL away.
- `shuffle` → *"pick something for me"*, without pulling the whole library into context.
- `played_year` → *"what did I play in 2025?"*, the basis of any year-in-review.

**Proposal.** One tool, `query_library`, with typed arguments per dimension rather than a raw
sort string — so the model discovers the vocabulary from the schema instead of guessing:

```
query_library(username?, shelf?, completion_status?, platform?, played_year?,
              rating?, category?, sort?, order?, page?, limit?)
```

Keep `get_library` as-is or fold it in; the URL builder is shared either way. Platform names
should be accepted in plain English and mapped to slugs (see P4).

**Confidence.** High — verified live against the account. All seven composed URLs returned
200 and parsed:

| Query | Result |
| --- | --- |
| `avg-finish-time` + `type:backlog` | 40 games — Animal Crossing: New Leaf, Satisfactory, Pathfinder: WotR |
| `shuffle` + `type:backlog` | 40 games, different order — Predecessor, Disco Elysium, Final Fantasy V |
| `game_status:completed` | 31 games — Balatro, Coldline, Buckshot Roulette |
| `rating:10` (5★) | 8 games — The Witness, Everlasting Summer, Life is Strange: BTS |
| `categories:games` on backlog | 40 games — Mixtape, A Short Hike, Silent Hill 2 |
| `type:backlog;release_platform:ps5` | 40 games — Mixtape, Silent Hill 2, Dispatch |
| `type:backlog;release_platform:wiiu` | **12 games** — Breath of the Wild, … |
| `type:backlog;genre:simulator` | 40 games — Subtransit Drive, MudRunner, Rare Replay |
| `type:backlog;release_year:2026` | 1 game — Mixtape |
| `type:played;played_year:2025` | 0 games — syntax accepted, this account has no 2025 logs |
| `type:backlog;played_platform:win` | 0 games — semantically empty (backlog items have no *played* platform) |

The two empty results are not failures: an **invalid** filter genuinely 500s on this site —
`/games/lib/popular/genre:rpg/` did exactly that during the original research — so a 200 with
zero rows means the grammar was understood and nothing matched. Worth encoding that
distinction in the tool's description so an empty result isn't read as a broken query.

**Cost.** One request per page, same as today. Pure win.

---

## P2 — Playtime and rating distribution on `get_game`

**The gap.** `get_game` returns the average rating but not how long the game takes or how the
ratings are spread. Both are on the page already, so this costs zero extra requests.

**What I confirmed.** Parsed live from the Elden Ring page:

- Time cards: **146h average**, **97h to finish**, **119h to master**
  (`.time-played-overview .stat-value` paired with `.label`).
- A full half-star histogram from the ratings bars' tooltips
  (`data-tippy-content="398 | 0.5 ★ Ratings (0.3%)"`), 10 buckets:

  | 0.5★ | 1★ | 1.5★ | 2★ | 2.5★ | 3★ | 3.5★ | 4★ | 4.5★ | 5★ |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 398 | 355 | 391 | 1044 | 1535 | 3790 | 7062 | 18105 | 29169 | 74380 |

**Why it matters.** Playtime makes "can I finish this in a weekend" answerable per game, and
pairs with P1's `avg-finish-time` sort. The histogram distinguishes *broadly liked* from
*divisive* — a 4.2 average from a flat spread means something different from a 4.2 with a
5★ spike.

**Proposal.** Add `playtime: { averageHours, hoursToFinish, hoursToMaster }` and
`ratingDistribution: { "0.5": 398, … }` to the `get_game` response. Both nullable — plenty of
games have no time data.

**Confidence.** High. Both parsed cleanly from a saved fixture.

**Cost.** Zero extra requests.

---

## P3 — Play sessions (`get_play_sessions`, `log_play_session`)

**The gap.** Backloggd models a playthrough as containing dated **play sessions**, each with
its own hours, note, status, privacy and tags. The server exposes none of this; `log_game`
can set a single start/finish date and a total playtime, and that is all.

**What I confirmed.** Sessions travel in the log-save payload as a `dates{}` map keyed by
playthrough id, each entry carrying:

```
id, range_start_date, range_end_date, start_date, finish_date,
status, note, hours, minutes, tags, privacy, edited
```

There is a dedicated modal endpoint, `POST /open-date-modal/`, that takes a `play_data`
object with exactly those fields. Session privacy is settable in bulk via
`POST /logs/sessions/privacy` (`new_privacy`). User tags come from `GET /tags/recent`, which
returns `{"tags": [...]}` — empty on this account, so I could not see a populated shape.

**Why it matters.** This is the difference between "I played Balatro" and a genuine play
journal: *"log 90 minutes on Balatro yesterday, note: finally beat the Acorn deck."* It is
also the data behind the journal view users already see.

**Proposal.** `get_play_sessions(game)` reading from the existing `/log/edit/{id}` payload
(sessions come back inside `playthroughs[].play_dates`), and `log_play_session(game, date,
hours, minutes, note?, tags?)` writing through the same `saveLog` path with a populated
`dates{}` map.

**Confidence.** High on reading (the payload is already fetched and simply discarded).
**Medium on writing** — the `dates{}` shape is understood from the bundle and from
`DanteCampos/Backloggd-Import`, but constructing a *new* session rather than editing one has
not been exercised. This is the proposal most in need of a throwaway-account test.

---

## P4 — Platform and genre vocabularies

**The gap.** `log_game` cannot set the platform you played on, because the id table was
unknown. This was open question 2 in `PLAN.md`.

**What I confirmed.** Two unauthenticated JSON endpoints resolve it:

- `GET /platforms/fetch/all/` → **227** entries, `{id: {value, name, sortKey}}`.
  Windows PC = 6, PlayStation 5 = 167, PlayStation 4 = 48, Nintendo Switch = 130.
- `GET /genres/fetch/all/` → **23** entries, same shape. Adventure = 31, Indie = 32,
  Fighting = 4.

These are IGDB ids, consistent with Backloggd's game ids also being IGDB ids.

**Proposal.** Fetch both once, cache for the process lifetime, and use them to (a) let
`log_game` accept `platform: "Nintendo Switch"`, (b) validate `browse_games`/`query_library`
genre and platform arguments and suggest near-matches on a typo, and (c) vendor a snapshot as
a fallback if the endpoints ever move.

**Confidence.** High — fetched live, parsed, spot-checked against known IGDB ids.

**Cost.** Two requests per process, cached.

---

## P5 — Notifications and friends' activity

**The gap.** No visibility into anything happening *to* the account.

**What I confirmed.** All 200 with the authenticated session:

| Path | What it is |
| --- | --- |
| `/notifications/` | Notifications page. **This account had none**, so I only captured the empty state (`#notifications-container`, "No recent notifications") — the item markup is unknown. |
| `/u/{user}/activity/` | Friends' activity feed (36 KB) |
| `/u/{user}/following/` · `/followers/` | Friends lists |
| `/u/{user}/likes/` | Content the user has liked |

**Proposal.** `get_notifications`, `get_friends_activity`, `get_follows(direction)`. Useful
for "anything new?" and for making `set_follow_user` usable — that tool currently requires a
numeric user id with no tool that returns one.

**Confidence.** High that the pages exist and are reachable. **Low on the notification item
parser specifically**, because I have no non-empty fixture. This one should be built against
an account that actually has notifications, or written defensively and verified later.

---

## P6 — Yearly stats / year in review

**The gap.** No aggregate view. `get_user_profile` returns three lifetime counters.

**What I found.** `POST /stats/{user_id}/yearly/{type}` returns `{data: {year: count}, max}`,
where `type` is one of `finished`, `first_played`, `release_year`, `ratings_year` (the last
returns doubled half-star values, which the front end divides by 2 to show an average).

**Confidence.** **Medium.** It is POST-only, and a GET returns 404 — so it is unverified. The
bundle shows it purely rendering a graph, so it is a read despite the verb, but I did not
POST to it: it is not on the already-exercised list, and the point of this pass was research
without side effects. Worth confirming before building on. `GET /stats/game/{id}/journal`
returned a 500 on this account, possibly because there is no journal data for that game.

**Proposal.** `get_yearly_stats(metric)` — but only after the POST is confirmed harmless and
working.

---

## P7 — Per-game log history and community logs

**What I confirmed.** `/u/{user}/logs/{slug}/` returns 200 (30 KB) and shows a user's full log
history for one game — every replay, with ratings and dates. There is also
`/logs/{slug}/plays/` with its own filter grammar
(`rating:10;`, `display:friends;rating:all;status:all;`) for browsing *community* logs of a
game, including a friends-only view.

**Proposal.** Extend `get_my_game_log` to optionally include the rendered history, and add
`get_game_logs(game, friends_only?, rating?)` for the community view. Lower priority: the
JSON from `/log/edit/` already covers most personal use.

**Confidence.** Medium-high — pages fetch and are clearly structured, parsers not written.

---

## P8 — List management depth

**The gap.** Lists can be created and have games added or removed, but not curated.

**What I found in the bundle** (none executed):

| Capability | Endpoint |
| --- | --- |
| Delete a list | `DELETE /api/list/{id}` — destructive, needs the confirmation flow |
| Reorder / rank entries | `PUT /api/list/{id}/update-entries-2/` (already wired for adds) |
| Per-entry notes | Staged client-side, submitted via `update-entries-2` |
| Discard pending edits | `PATCH /api/list/{id}/discard-entries/` |
| List folders | `POST`/`DELETE /api/list/folder` (`title`, `list_ids`, `default_sort`) |

Ranked lists are a first-class type (`create_list` already accepts `ranked`), so ordering
entries is the natural companion.

**Proposal.** `reorder_list`, `set_list_entry_note`, and `delete_list` (destructive, gated).
Medium priority — real curation value, but a heavier lift than P1–P4.

**Confidence.** Medium. Endpoint shapes are read from call sites; the `update-entries-2`
payload for reordering is more complex than the add path and needs a test account.

---

## P9 — Smaller gaps worth noting

- **Search non-games.** `/search/results/` takes `type`; only `games` is used. Users and lists
  are searchable, which would give `set_follow_user` a way to find its user id.
- **Favourites.** `POST /add-favorite/{game_id}/` adds to profile favourites. Removal appears
  to go through the profile settings form (`PATCH /users/{id}`), not a dedicated endpoint.
- **Review drafts.** `POST /user/review/draft` (`review`) saves a draft — nice for "draft this
  and let me look at it later".
- **Comments.** `/comment/`, `/comment/edit/`, `/comment/destroy/` exist for reviews and lists.
  Deliberately low priority: posting public comments on other people's content is the
  highest-blast-radius thing in this whole API, and I would gate it hard or leave it out.
- **GOTY lists.** A yearly game-of-the-year feature with its own endpoints
  (`/api/list/goty/{id}/game_search/`, `/goty/entry/submit/`). Seasonal and niche.
- **Export.** No export endpoint exists; a `export_library` tool would just be `query_library`
  paged to exhaustion. Reasonable to offer, but it is many requests — should be explicit about
  that and respect the rate limiter.

---

---

# Part 2 — Gap analysis against eight real questions

Eight questions an agent with this server (plus web access) should be able to answer. The
division of labour assumed here: **Backloggd supplies the user-specific facts** (what's mine,
what shelf, which list) plus whatever game metadata it happens to hold; **the web and the
model's own knowledge supply general knowledge** (is this co-op? is this a space sim?). The
job of the server is to make the personal half retrievable cheaply and completely.

| # | Question | Today | With P1–P9 | Still needs |
| --- | --- | --- | --- | --- |
| 1 | Backlog games released on PS5 | ✗ | **✓ one request** | — |
| 2 | VR list entries not native on Quest 3 | ✗ | partial | **P10** bulk metadata |
| 3 | Space sims in my backlog | clumsy | **✓** (`genre:simulator` + reasoning) | **P13** helps |
| 4 | Backlog games good for controller co-op | ✗ | partial | **P13** + web (Backloggd has no co-op data) |
| 5 | Wii U games in backlog **or any list** | ✗ | backlog **✓**, lists ✗ | **P11** collection-wide union |
| 6 | Which Call of Duty games am I missing | **✓ already** (web + `check_games`) | ✓✓ **P14** answers it from Backloggd alone | — |
| 7 | Backlog games with missing sequels/remasters | ✗ | **✓ per game** | **P12** series/DLC frame (now verified working) |
| 8 | Top-rated 2026 games not in any of my lists | **✓ already** | ✓ | — |

Two are already answerable today, three become answerable with P1 alone, and three need new
work. Details on the interesting ones:

**Q1 — PS5 games in my backlog.** Solved outright by adding `release_platform` to P1:
`type:backlog;release_platform:ps5` returned 40 games in a single request. This was the
question that exposed my `played_platform`-only mistake.

**Q5 — Wii U games in my backlog or any list.** The backlog half is now one request
(`release_platform:wiiu` → 12 games, verified). The "or any list" half is genuinely blocked:
**list pages ignore the filter grammar.** I confirmed this by appending `release_platform:ps5`
to the VR list URL and getting a byte-for-byte identical 100-game response. Hence P11.

**Q6 — missing Call of Duty games.** Works today via web-franchise-list + `check_games`, and
gets substantially better with **P14**: `/company/activision/release/` returns every Activision
title *with your shelf state already attached*, 60 per request, so the agent can find the gaps
without a per-title fan-out or an external catalogue. **P12**'s series frame
(`/update_game_detail/621/series/` → the six classic CoD titles) helps too, though IGDB splits
Modern Warfare and Black Ops into separate collections, so the company route is the more
complete one.

**Q8 — top-rated 2026 games not in my lists.** Already works:
`browse_games(sort: "rating", release_year: "2026")` returned 60 games (Resident Evil
Requiem, Slay the Spire II, Denshattack), and `check_games(include_lists: true)` on the top
slice reports both shelf and list membership — which is exactly the "mark separately" the
question asks for.

**Q4 — co-op recommendations.** Backloggd simply has no multiplayer/game-mode metadata; I
looked. There are no themes either. This one is inherently web-plus-reasoning, and all the
server needs to do is hand over the backlog efficiently (P13).

---

## P10 — Bulk game metadata (`get_games_metadata`)

**The gap.** Library cards, list cards and journal rows carry only id, slug, title and cover.
Platforms, genres and year come only from the game page — one request each. So any question of
the form *"for these N games I already have, tell me X"* costs N requests. That is what blocks
Q2 (139 games in the VR list) and hurts Q4 and Q7.

Search results *do* carry platforms (`.search-result-platforms`), but search is also one
request per query, so it is no cheaper.

**Proposal.** `get_games_metadata(games[], fields?)` — resolve and fetch metadata for a set of
games, returning platforms, genres, year, category, average rating and playtime. Implementation
notes that matter:

- It is **N requests**, and the tool description must say so plainly rather than looking cheap.
  Cap the batch (~25) and report what was dropped.
- The 6-hour game-metadata cache already exists, so a follow-up question over the same list is
  nearly free. This changes the cost profile a lot for iterative use.
- Where the question is "which of my *library* is on platform X", steer callers to P1 instead —
  one request beats N. `get_games_metadata` is for sets that are **not** a library query, which
  in practice means list contents.

**Confidence.** High — it composes existing, tested parsers. The only open question is
tolerable batch size on a slow link.

---

## P11 — Collection-wide search (`find_in_collection`)

**The gap.** "In my backlog **or any of my lists**" cannot be expressed. Shelves are queryable;
lists are a separate, unfilterable world. With 12 lists (one of them 139 games) the union is
not something an agent should assemble by hand each time.

**Proposal.** `find_in_collection(filters…)` that unions the shelf query with the contents of
every list, returning each game once annotated with **where** it came from
(`shelves: ["backlog"], lists: ["VR", "Next Up"]`).

Cost is honest and bounded: one shelf query plus one request per list page (lists render 100
per page, so most lists are a single request). For this account that is roughly 15 requests,
cached afterwards. Where a platform/genre filter is supplied, apply it server-side to the shelf
half and client-side to the list half via P10's cached metadata.

**Confidence.** Medium-high. Every underlying request is verified; the composition and its cost
are the design work.

---

## P12 — Series, DLC and related games (`get_related_games`)

> **Correction.** An earlier draft of this section claimed Backloggd has no usable series data,
> based on `/games/call-of-duty/related/associated/` returning three titles. That was wrong,
> and wrong for an avoidable reason: those `/games/{slug}/{section}/` URLs return a **lazy
> shell** — the section is a `<turbo-frame>` full of shimmer placeholders. I was counting
> placeholders. The frame declares its real source, and fetching that returns the actual data.

**The endpoint.** Every related-games section is served by one URL, keyed by **game id**:

```
GET /update_game_detail/{game_id}/{section}/
     sections: series · dlc · editions · mods · in-bundle · related/associated
```

Verified live:

| Call | Result |
| --- | --- |
| `/update_game_detail/621/series/` (Call of Duty) | **6 games** — CoD 2, CoD 3, CoD 4: Modern Warfare, Big Red One, Finest Hour, Roads to Victory |
| `/update_game_detail/119133/dlc/` (Elden Ring) | 1 — Shadow of the Erdtree |

The game page's own frame confirms the id semantics: Call of Duty carries
`data-game-id="621"` and `src="/update_game_detail/621/series/"`. Responses are small
(3–20 KB) — far cheaper than the 90 KB page they came from.

**Scope, honestly.** Series follows IGDB's *collection* grouping, which is narrower than a
marketing franchise: Call of Duty's series is the six classic-era titles, while Modern Warfare
and Black Ops sit in their own collections. So this answers "what else is in this game's
grouping, and does it have DLC / editions / a remaster I don't own" — genuinely most of Q7 —
but it is not a complete franchise index. For that, see company browsing below.

**Cost.** One small request per game per section. Fine for a handful of games; not something
to run across a 349-game backlog.

**Confidence.** High — fetched and parsed live.

---


## P13 — Exhaustive library dump (`export_library`)

**The gap.** Q3 and Q4 need the agent to reason over the *whole* backlog with its own
knowledge. `get_library` returns 40 per page and makes the caller drive pagination, which an
agent does inconsistently and which risks silently answering from page 1 only.

**Proposal.** `export_library(shelf?, filters?, max_games?)` that pages to exhaustion and
returns a compact `{id, title, year, slug}` list — deliberately minimal, because the point is
to fit a few hundred titles in context, not to be rich.

Two details that matter: Backloggd **re-serves the last page forever** for out-of-range page
numbers, so termination must compare id sets between pages (the existing parser already knows
this); and the response must state how many pages were fetched and whether `max_games`
truncated the result, so a partial answer is never mistaken for a complete one.

For this account the backlog is 349 games ≈ 9 requests. Combining with P1 filters first is
usually better: `genre:simulator` before dumping turns Q3 from 9 requests into 1.

**Confidence.** High — pure composition of a verified parser.

---

## P14 — Company catalogues (`browse_company`)

**What I found.** `/company/{slug}/` is a full, paginated, sortable catalogue of a company's
games — and this is the find of this pass, because **the cards carry `preloaded-log` blocks**,
meaning each game arrives annotated with *your own* shelf, rating and like state. 60 games per
request, no extra lookups.

| Property | Detail |
| --- | --- |
| URL | `/company/{slug}/{sort}/?page=N` |
| Sorts | `popular`, `rating`, `release[:asc\|:desc]`, `title`, `time-played`, `time-finished` |
| Page size | 60 games (verified: FromSoftware p1 = 60, Activision p2 = 56) |
| Your status | **Included** — 60 cards, 60 `preloaded-log` blocks |
| Slugs | From `/company/` links on any game page (`fromsoftware`, `bandai-namco-entertainment`, `activision`) |

**Why it matters.** This is the missing half of Q6. "Which Call of Duty games am I missing?"
can now be answered largely from Backloggd itself: browse `/company/activision/release/`,
which returns every Activision title *with your shelf state already attached*, and the agent
filters to Call of Duty entries and reports the gaps. No per-game `check_games` fan-out, and no
dependence on the web for the catalogue. It also answers a natural question class the server
cannot touch today at all — *"what FromSoftware games haven't I played?"*, *"how much of
Nintendo's Switch output do I own?"*

**Proposal.** `browse_company(company, sort?, page?)` returning games plus your entry, exactly
like `query_library` rows. Reuse the existing library-card parser — the markup is the same, so
this is largely free. Company slug resolution can piggyback on `get_game`, which already
extracts `/company/` links into `developers`.

**Confidence.** High — both pages fetched live, cards and preloaded-log blocks counted.

**Cost.** One request per 60 games.

---

---

## Vocabulary needed by P1 (extends P4)

The filters need slugs, not display names, and I now have the complete set:

- **227 platform slugs**, parsed from the `#plat-released-on` select on any library page:
  `win`, `ps5`, `wiiu`, `switch`, `switch-2`, `series-x-s`, `ps4--1`, `steam-deck`, and — for
  Q2 — `meta-quest-3`, `meta-quest-2`, `oculus-quest`, `psvr2`, `steam-vr`. Note the irregular
  ones (`ps4--1`, `genesis-slash-megadrive`); these cannot be guessed and must come from the
  table. Beware that the option values are **unquoted HTML** (`<option value=win>`), which a
  naive `value="([^"]*)"` regex silently misses.
- **23 genre slugs** from the `#genre` select: `simulator`, `role-playing-rpg`, `shooter`,
  `hack-and-slash-beat-em-up`, `real-time-strategy-rts`, `turn-based-strategy-tbs`, etc.

Both should be fetched once, cached, and exposed to the model — either as an enum in the tool
schema where the list is short (genres) or via a small `list_filter_values` helper for
platforms, with fuzzy name matching so a caller can say "Quest 3".

An invalid slug **500s** rather than returning nothing (`genre:rpg` errors; the real slug is
`role-playing-rpg`), so validating client-side against these tables turns a confusing server
error into a clear "did you mean" — and, usefully, means an empty result set can be trusted as
a real "nothing matched".

---

## Recommended order

**Do first — cheap, high value, low risk:** P1 (library query, *including*
`release_platform` / `genre` / `release_year`), P2 (playtime + histogram), P4 + the slug
vocabularies. All read-only, no new write paths. On their own they turn questions 1, 3 and
half of 5 from impossible into single requests, and they cover the "what should I play next"
workflow a backlog tool exists for.

**Do second — taxonomy browsing, nearly free:** P14 (company catalogues) and P12 (series /
DLC frames). Both reuse the existing library-card parser, both return your own status inline,
and together they cover "what else exists near what I already have" — franchises, developers,
remasters, DLC.

**Do third — the composition tools:** P13 (exhaustive dump) then P11 (collection-wide union)
and P10 (bulk metadata). These are what let an agent combine Backloggd's personal data with
its own knowledge of games, which is where the remaining questions live.

**Do next, with a test account:** P3 (play sessions) and P8 (list curation) — both write
paths whose payloads are understood but unexercised.

**Do when there's a fixture:** P5 (notifications) — blocked on an account with actual
notifications.

**Lower priority:** P6–P9 as before.

**Confirm before building:** P6 (yearly stats) — the endpoint is POST-only and unverified.

## Things I deliberately did not do

- No writes of any kind. Every write shape above was read out of the JS bundle.
- No POST to `/stats/.../yearly/`, even though it is almost certainly a read, because it was
  not already on the exercised list.
- No attempt to enumerate another user's private data.

---

## Appendix: live probe results

Endpoints reached with the authenticated session during this pass:

```
OK             /u/{u}/games/avg-finish-time/type:backlog/     40 games parsed
OK             /u/{u}/games/…/type:backlog;release_platform:ps5/   40 games
OK             /u/{u}/games/…/type:backlog;release_platform:wiiu/  12 games
OK             /u/{u}/games/…/type:backlog;genre:simulator/        40 games
OK   20627b    /update_game_detail/621/series/     6 CoD titles (frame endpoint)
OK    3728b    /update_game_detail/119133/dlc/     1 (Shadow of the Erdtree)
OK  272282b    /company/fromsoftware/              60 games + 60 preloaded-log blocks
OK  276355b    /company/activision/                60 games; ?page=2 → 56
--             /u/{u}/list/vr/release_platform:ps5/  IGNORED — byte-identical to unfiltered
OK             /u/{u}/games/shuffle/type:backlog/             40 games parsed
OK             /u/{u}/games/added/game_status:completed/      31 games parsed
OK             /u/{u}/games/added:desc/rating:10/              8 games parsed
OK             /u/{u}/backlog/added:desc/categories:games/    40 games parsed
200    36107b  /u/Denision/activity/          HTML  friends' activities
200    30181b  /u/Denision/following/         HTML  friends
200    41540b  /u/Denision/likes/             HTML  liked content
200    25097b  /notifications                 HTML  (empty state)
200       11b  /tags/recent                   JSON  {"tags":[]}
200      841b  /genres/fetch/all/             JSON  23 genres
200    12346b  /platforms/fetch/all/          JSON  227 platforms
200    30814b  /u/Denision/logs/elden-ring/   HTML  per-game log history
200       15b  /library/get/119133            JSON  {html_res}
404            /u/Denision/stats/             — stats live elsewhere
404            /series/all                    — needs params or is admin-only
404            /journal/friends/              — needs params
404            /stats/181645/yearly/finished  — POST-only (GET 404s)
500            /stats/game/119133/journal     — likely no journal data for this game
```

Several probes also failed with headers/body timeouts. Those are the known flaky path to
Backloggd, **not** evidence the endpoint is broken — anything marked as a timeout was retried
or is listed as unverified rather than as failing.
