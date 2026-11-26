# Eval Rubric — iRecall Search Tab Redesign v1

Test against /Users/nick/dev/recall/gan-harness/spec.md. Section 6 checklist is pass/fail ground truth.

## Design Quality (weight: 0.30)
- Search tab opens empty and calm — no auto-filled list, no skeleton noise; filter bar legible and inert until used.
- Matches existing dark Console theme (CSS custom props, no framework); no new visual language invented.
- Minimal-UI philosophy respected: added chrome limited to filter bar, status line, empty-state panel.

## Originality (weight: 0.15)
- Category = client-side domain buckets; confidence = normalized Any/Relevant/Strong buckets. NOT a stored-category migration, NOT a slider, NOT raw mode-dependent scores surfaced to the user.
- Empty state is purposeful (example queries + Pages-tab pointer), not a stub or a disguised feed.

## Craft (weight: 0.25)
- Empty, zero-match, and bucket-reduces-below-limit states all handled; "clear filters" affordance on zero matches.
- Status-line count always equals displayed hits; scores 0–100, top = 100, non-increasing down the list.
- No layout shift or flash of results before the first query.

## Functionality (weight: 0.20)
- Every §6 acceptance criterion passes; filters AND correctly; domain and time presets hit the existing server params.
- keyword↔hybrid both work with identical confidence semantics (normalize per set).
- Existing /search contract unchanged; no new endpoints.

Fail conditions (any one fails the eval): any auto-query on open; category requiring a schema change; confidence displayed as raw rank.
