# UX dogma

Three surfaces: dashboard SPA, tray/menu-bar app, extension popup. All
feedback is inline and honest — no alert(), no silent states, no lies
about what the system knows.

## Dashboard (`server/public/index.html` — single file, hash-router SPA)

- Tabs: search / pages / focus / blocked / settings; `#tab` + deep views
  (`#pages/<date>`, `#site/<domain>`). Route parser checks TABS first.
- ALL async feedback goes through the global `#status` region
  (`aria-live=polite`) — never alert/confirm.
- Every tab has loading, empty, and error states. `[hidden] { display:
  none !important }` is the toggle primitive.
- Fonts: Host Grotesk (UI) + Atkinson Hyperlegible Mono (numbers/paths),
  Google Fonts.
- Extension state is global, not Settings-only: amber banner on every tab
  when captures are at risk (not connected && not dismissed), polled
  60 s, dismiss wired to the server flag so tray + dashboard agree.
- Copy discipline: "Not installed" (never seen) vs "Not checking in —
  last seen X ago (Chrome closed?)" vs "Connected". Unknown state
  (server predates extension field) must surface as "Server outdated",
  NEVER silently look healthy — that exact bug shipped.
- Faithfulness: pages you embed that aren't yet embedded are never
  deleted; previews show what WOULD be pruned, with scores, before save.

## Tray (Tauri, accessory app — no dock icon)

- Icon: template `iR` monogram (follows menubar tint); warn variant
  (grey chip + yellow badge) ships full-color NON-template so the badge
  survives tinting. Warn = healthy && extension not connected && not
  dismissed.
- Menu: status line (recording state / server down / server outdated),
  Pause/Resume, "Set Up Chrome Extension…" (ALWAYS enabled — a greyed
  item masquerades as a dead click), Open Dashboard, Quit.
- Setup window auto-opens once per launch on warn; auto-closes on
  dismiss or connect. Loading icons via `include_bytes!`; frontend via
  `frontendDist: "static"` (embedded — no loose files in the bundle).

## Extension popup

- Fixed `width: 400px` on body — Chrome sizes the popup from body's
  preferred width; percentage widths collapse it. Fluid under
  `max-width: 400px` media query.
- Popup links open via `chrome.tabs.create` (a plain <a href> click just
  closes the popup).
- Teach fallback: Readability returns nothing on virtualized feed DOM —
  fall back to `document.body.innerText` so app-shell pages still teach.
