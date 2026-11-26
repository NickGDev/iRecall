# iRecall — Pages Tab: Date Browse, Site Drill-down, Retention Rules (v1)

> Brief: mature Pages so it (1) shows all sites captured on specific dates, (2) opens a site and shows its individual pages, (3) creates per-page or per-site auto-delete rules (a date or a max age). Requirements and ranked decisions only; implementation is designed separately.

## 1. Problem

Owner intent: the Pages tab is a flat "latest 15" feed — no way to ask "what did I look at on Nov 12?", no way to see everything stored from one site, no per-item retention control (only the global retentionDays purge and one-shot bulk deletes). The Search redesign (spec.md §4) already redirects ambient browsing here, so Pages is now the browse surface and must actually support browsing. Verified ground it builds on: `supersededBy`/`stale` are computed at read time (never stored), deletes already cascade vectors and FTS cleanly, and `DELETE /pages/:id` plus a per-row Delete button already exist.

## 2. Date browsing (ranked)

1. **PICK — Day rail + day view.** A horizontal rail of day pills (date + capture count) for days that have captures, newest first, ending in an "older" shift (default window 30 days, cap 60). A native `<input type="date">` beside it jumps to any date. Picking a day renders that day's captures in the existing trail-row pattern (time in the left cell), capped at 50 rows with a "show 50 more" button. Zero-capture days are skipped, never padded — the rail is a table of contents of the record, not a calendar. Both the selected day and the site view are hash routes (`#pages/<date>`, `#site/<domain>`) so back/forward work.
2. **Defer — sites-per-day grouping.** Day rows grouped under per-domain subheads inside the day view. Nice density gain, but it duplicates what drill-down gives; revisit only if flat day trails prove hard to scan.
3. **Reject — month calendar grid.** Custom framework-free month DOM is the largest chunk of chrome this tab could gain, for navigation the native date input already covers.
4. **Reject — infinite scroll.** Hides the cap, fights the "show more" pattern used elsewhere, and makes the server paging contract murky.

Day semantics are **local-timezone days**, decided server-side (`date(captured_at/1000,'unixepoch','localtime')`) so one authority defines a day; the existing `url_day_hash` UTC-day stays dedup-only and is untouched.

## 3. Site drill-down (ranked)

1. **PICK — Dedicated site view.** `#site/<domain>` lists every capture of that site, newest first, one row per capture, same trail-row pattern, capped 50 + "show more". Reached by making every rendered domain label a link: day view, recent feed, and Search rows all gain a clickable domain. Domain matching is exact + `www.` tolerance, matching the Search domain filter (store.ts ftsLeg) — browse stays narrower than policy (retention rules below use subdomain scope).
2. **Defer — inline per-domain accordions in the day view.** Keeps context but doubles DOM/state and still needs somewhere for Search domains to link; the site view is strictly more general.
3. **Overkill — sites directory page.** A ranked all-domains index is browse-surface creep; the stats panel already counts sites.
4. **Superseded versions: PICK — one row per capture, visibly linked.** Dedup means rows exist only when content actually changed, so collapsing would hide real history; Search already renders a "superseded by #id" chip (index.html:761) and the tab's own intro says "the record". Rows show the existing stale/superseded chips. Defer a "collapse duplicates" toggle if the view gets noisy; Reject default-collapsed (inconsistent with Search surfacing them).

Invariant: because `supersededBy` is derived per read, deleting any row cannot dangle a reference — the older sibling simply re-points to the next surviving newer row on next fetch. The obligation is that all views re-fetch (re-annotate) after any delete; no stored-id cleanup exists to get wrong. Vector/FTS cleanup is already automatic (`page_vectors … ON DELETE CASCADE`, `foreign_keys = ON`, `pages_ad` trigger) — v1 adds no delete-path code.

## 4. Retention rules v1 (ranked)

**Storage:**
1. **PICK — settings KV, JSON array (blocked_domains precedent).** One `retention_rules` key: `[{id, scope:'page'|'site', key, mode:'on'|'maxAge', value, createdAt}]`. Rules are handful-scale user config with no blobs; read-modify-write on change is what blocked_domains already does; zero schema change.
2. **Reject — dedicated table (focus_rules precedent).** focus_rules earns a table via per-row PATCH/DELETE and BLOB topic vectors; retention rules need neither, so a table is migration work for nothing at v1 scale.
3. **Reject — per-page columns on `pages`.** Couples policy to data, needs backfill, and can't express future rules for pages not yet captured.

**Keying:** page rules key on the exact URL string copied from the row (covers all versions of that URL, current and future re-captures; tracking-param variants are not covered — known ceiling, a site rule is the broad answer). Site rules key on a domain and reuse `domainInScope` (exact or subdomain), matching focus rules and the blocklist.

**Enforcement:**
1. **PICK — sweep-only on the existing idle tick.** The 30s idle worker already runs `purgeExpired` hourly; rule application joins that sweep, and saving/deleting a rule sets a jump-the-queue flag exactly like focus rules' `sweepDue`. One code path, zero ingest cost.
2. **Reject — on-ingest check too.** Fresh captures can't be expired on arrival under either mode; the check is dead weight.
3. **Max-age anchors to each row's `captured_at`** (a site rule "30d" means every page dies 30 days after its own capture), consistent with the global retention purge. Delete-on stores the local midnight starting the chosen date; the first sweep after it deletes.

**Precedence:** most aggressive wins — a page under both a page rule and a site rule deletes at the earliest of the two dates. No exemption concept ("keep this page despite the site rule") in v1. Rules can only shorten retention, never extend it: a maxAge larger than the global retentionDays is inert, and the rules list must label such rules inert rather than let them imply protection.

**UI and destructive semantics:** creating a rule returns its current match count; the UI confirms before saving when the count is nonzero (existing `confirmDelete` pattern) — that count is the destructive preview, there is no undo, consistent with "Deleting here is permanent". Rows under a rule show a badge chip ("auto-delete Jan 1" / "auto-delete 30d") in every view. Settings gains a rules overview line-listing active rules with match counts, lifetime deleted counts, and a delete-rule action (deleting a rule stops future deletion only; confirm mirrors the focus-rule wording). Auto-deletion is background, so the user learns of it from a status line, never a modal: after each sweep the server stores `{at, deleted}` in settings, `GET /api/retention` returns it, and both the Pages tab and the rules overview render one line ("last auto-delete: 3 pages, Nov 26 09:00").

## 5. v1 scope (priority-ordered)

Must-have:
1. Day rail + day view with cap/show-more (`GET /days`, `GET /pages?day=`).
2. Site drill-down + domain links from day view, recent feed, Search rows (`GET /pages?domain=`).
3. Retention rules: create per-page/per-site, date or maxAge; badges on matching rows; Settings overview with counts; sweep enforcement + jump flag; sweep status line.

Should-have: day+domain combined filter (same handler, one param more) · inert-rule labeling · "older" paging on the day rail.

Defer: sites-per-day grouping · collapse-duplicates toggle · exemption rules · trash/undo for auto-deletes · MCP exposure of the new listings.

## 6. Endpoints

All additions; nothing existing changes shape.
- **GET /days?limit=60** — new. `[{day:'YYYY-MM-DD', count}]`, local-day buckets, descending, capture-days only.
- **GET /pages?day=YYYY-MM-DD|domain=X&limit=50&offset=0** — new GET on the existing `/pages` path. Annotated rows (ageDays/supersededBy/stale), newest first, `www.` tolerance on domain, `total` for show-more. Optional `domain` + `day` together.
- **GET /api/retention** — new. `{rules:[{…, matches, deleted}], lastSweep:{at, deleted}}`; `matches` computed per rule at read (blockedWithCounts pattern).
- **POST /api/retention** — new. `{scope, key, mode, value}`; validates (on = epoch ms, maxAge = 1–3650 days, page key = http(s) URL, site key via normalizeDomain); returns the rule with its match count. Sets the sweep flag.
- **DELETE /api/retention/:id** — new. Stops future deletion; deletes nothing.
- **DELETE /pages?domain=X&olderThanDays=N** — additive combo on the existing endpoint (AND semantics) so "apply this maxAge rule now" composes existing surface; likewise `?url=` for page rules. No dedicated run-now route: saving a rule applies within one 30s tick anyway.

## 7. Acceptance criteria

- [ ] Opening Pages shows the day rail with only days that have captures; counts match `GET /days`; no padded zero-capture pills.
- [ ] Picking a rail day (or a date in the input) renders that local day's captures, newest first, each row's time cell within the chosen day.
- [ ] A day with >50 captures shows exactly 50 rows plus a working "show 50 more".
- [ ] Clicking a domain on a day row, a recent row, and a Search row all land on that site's view listing only its captures (www and bare host included).
- [ ] A site with superseded versions shows one row per capture; superseded rows carry the existing chip and no row claims to be latest while a newer one is listed.
- [ ] Back/forward navigate between `#pages/<date>`, `#site/<domain>`, and tabs without reload.
- [ ] Creating a site rule "maxAge 30" on a domain with 12 stored pages returns matches:12 and confirms before saving; after the sweep tick, rows older than 30d are gone and the status line reports the deletion.
- [ ] A page rule with delete-on date in the future deletes nothing until that local date passes, then deletes every version of that URL on the next sweep.
- [ ] A maxAge rule longer than the global retention renders labeled inert and deletes nothing the global purge wouldn't already delete.
- [ ] Deleting the newest version of a URL leaves no dangling superseded reference: remaining rows re-annotate correctly on refetch.
- [ ] Deleting a rule changes no stored pages; match counts disappear from badges on next load.
- [ ] With the server down, Pages renders the existing error state; no new unhandled promise paths.

## 8. Non-goals (v1)

- No schema migration of any kind; no new tables, columns, or backfills.
- No exemption ("keep forever despite a site rule"), no trash/undo, no per-rule notification surface beyond the sweep status line.
- No calendar month grid, no heatmap, no infinite scroll.
- No subdomain grouping in browse views (browse = exact + www; only policy is subdomain-scoped).
- No changes to ingest, search ranking, focus rules, blocklist behavior, or the extension.
- No accounts, sync, i18n, or MCP tool additions for the new listings.
