# iRecall — Search Tab Redesign: Product Requirements (v1)

> Brief: fix "messy" Search tab (auto-filled results on open) and add category + confidence filtering. Requirements and ranked decisions only; implementation is designed separately.

## 1. Problem

Owner intent: search "shows all results out of the gate" and offers no way to filter by category or confidence. Root causes, ranked:

1. **Browse/query conflation.** The tab auto-runs a "Latest captures, newest first" (15 items) query on open with an empty search box. The results area is never empty, so query output and ambient feed look identical — the direct source of "messy".
2. **No narrowing controls.** GET /search already accepts domain, since/until, mode, limit (1–100); the UI exposes only q at a hardcoded limit. Every query returns one flat, un-narrowable list.
3. **Illegible relevance.** Hit rank uses incompatible scales (keyword ≈ 0..1; hybrid RRF ≈ 0.001..0.03) with no legible strength signal; existing per-hit signals (ageDays, dwellMs, stale, supersededBy) do nothing to structure the list.

## 2. Category — definition for v1 (ranked)

1. **PICK — Domain-derived buckets.** Category = coarse bucket computed at render time from the hit's domain via a small static mapping (exact matches + suffix rules), e.g. Dev/Docs, Social, News/Reference, Other. Zero schema change, zero ingest change, applies retroactively to the whole existing corpus. Unknown domains land in an explicit "Other" bucket — never dropped, never mislabeled. A user-editable domain→bucket map in Settings is nice-to-have.
2. **Defer unless free — Focus-rule topics.** Semantically the best categories (user authored them; ingest already enforces them), but usable only if a page↔rule association is queryable at search time. Verify cheaply before building: if the link is already stored, promote this to the v1 pick; if it would need new persistence, defer.
3. **Overkill — Stored category column at ingest.** Requires schema migration + backfill and cleanly covers only new captures. Agreed: too heavy for v1. Revisit only if domain buckets prove too coarse in daily use.
4. **Indefinite defer — Manual tags.** New storage plus a tagging workflow is maintenance overhead a single-user local tool should not carry.

## 3. Confidence — definition for v1

**Displayed number:** per-hit **Match strength 0–100**, normalized within the current result set (min–max over returned rank; best hit = 100). Mode-agnostic by construction: keyword and hybrid scores normalize identically because scaling is relative to the set, not absolute. Label it as relative ("relative to this result set"); never persisted, never compared across queries.

**"Set confidence" = preset buckets (one mechanism, picked):** segmented control **Any | Relevant | Strong** with thresholds on the normalized score (suggest 0 / 40 / 70; tune during implementation). Applied after normalization, so behavior is identical in both modes and the control reads as "trim weak hits from this list".

Rejected: raw-score minimum filter (needs an absolute scale — impossible across modes); continuous slider (implies precision RRF scores do not have).

Edge: bucket-filtering the fetched set can display fewer rows than the limit. Acceptable; the status line must report the displayed count.

## 4. Empty state (core fix)

The Search tab opens in query mode: **no auto-query, no pre-filled results, no spinner.**

- Query input focused; filter bar visible and inert.
- Empty-state panel: one-line purpose statement, 2–3 clickable example queries (click = run), pointer to the Pages tab for browsing.
- The "Latest captures" auto-fill behavior is removed from Search entirely; Pages is the browse surface.

## 5. Filter bar — priority order

Must-have v1:
1. Query input (exists) — Enter runs the search; explicit search action stays.
2. Category select (All + buckets) — owner ask; client-side, derived per §2.
3. Confidence buckets Any/Relevant/Strong — owner ask; per §3.
4. Domain filter — wires the existing server param (exact match); effectively free.
5. Time presets Any / 24h / 7d / 30d / 90d — wires existing since/until; effectively free.

Should-have: mode toggle keyword/hybrid (server param exists; hybrid default) · "hide superseded" checkbox (field exists) · status line ("N results · mode · ms").

Deferred: custom date-range picker · limit control (use "show more" instead of a raw number) · multi-select category · saved filters.

Rules: filters AND together; state persists while the dashboard is open; changing the query re-runs with current filters.

## 6. Acceptance criteria

Each independently verifiable:
- [ ] Opening Search issues no search request; results area shows the empty state until a query runs.
- [ ] Clicking an empty-state example query runs it and renders results.
- [ ] Category = Social returns only hits whose domain maps to Social; All restores the full set; unknown domains appear under Other.
- [ ] Strong keeps the top-ranked hit visible; every hidden hit's normalized score is below the Strong threshold.
- [ ] Top hit shows Match strength 100; displayed scores are non-increasing down the list and within 0–100.
- [ ] Domain filter: every returned hit's domain exactly equals the filter value.
- [ ] Time preset 7d returns only hits with ageDays ≤ 7 (correct since/until actually sent).
- [ ] Category + time + confidence combined AND correctly; status count equals displayed hits.
- [ ] Zero matches shows a "no matches" state with one-click "clear filters".
- [ ] Switching keyword↔hybrid re-runs the query; scores stay 0–100 with top = 100.

## 7. Non-goals (v1)

- No schema migration, stored category column, or backfill; no ingest changes.
- No manual tagging UI.
- No absolute or cross-query confidence calibration.
- No new backend endpoints or parameters — v1 uses existing /search capabilities plus client-side bucketing/filtering.
- No search-as-you-type / instant search.
- No saved searches, no pagination redesign, no changes to other tabs.
