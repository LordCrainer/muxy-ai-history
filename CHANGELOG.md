# Changelog

All notable changes to AI History are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-06-30

### Fixed
- **`loadProjectLabels` could exceed Muxy's concurrent-exec limit.** It fired one `git rev-parse` per unique decoded project path via an unbounded `Promise.all`, so users with more than 32 distinct project directories hit `exec: too many concurrent commands (limit 32)` and every `git rev-parse` in the batch failed, leaving `state.gitToplevelMap` empty. Now batched in groups of 16 in `src/panel/main.js`.
- **Mount-time sync never resolved a root when the focused Muxy tab wasn't itself a git-scoped terminal** (e.g. a Claude Code / agent tab, or the extension panel itself) — `muxy.git.repoInfo()` returns `{}` in that case even though Muxy's own project switcher has an active project. Added `getActiveProjectPath(muxy)` in `src/panel/project-change-listener.js`, which reads the `isActive` project from `muxy.projects.list()` as a fallback whenever `repoInfo()` comes back empty. Used both at mount and in the polling fallback.
- **The polling fallback (auto-follow) could silently never start.** `setupProjectChangeListener()` ran synchronously at script load, before Muxy's `muxy` global was guaranteed to be injected; if `muxy` wasn't ready yet, `startPollingFallback`'s defensive guard returned `{ active: false }` and the interval was never installed — so switching the active project in Muxy was never reflected without a full panel reload. `setupProjectChangeListener()` is now deferred until after the first `loadConversations()` resolves, since `muxy` is confirmed available by then.
- **Polling always ran the 6 guessed candidate event names as a gate.** `startPollingFallback` previously only started when *zero* of the `PROJECT_CHANGE_CANDIDATES` event names subscribed successfully — but `muxy.events.subscribe` does not validate the event name, so a candidate can report "subscribed" even though Muxy never actually emits it, permanently blocking the reliable polling path. Polling now always runs alongside any event subscription; `applyFilter`'s dedup against `state.projectFilter` makes a redundant tick a no-op if the event does fire.

### Added
- **Mount-time Muxy project sync.** When the panel loads, the filter now reflects Muxy's currently active project (`muxy.git.repoInfo().root`) even if no project-change event has fired yet. Previously the panel only synced the filter when a Muxy `project.changed` event (or one of the 5 other candidate event names) was received — until then, the picker button showed `All projects` even when Muxy had an active project. The sync runs ONCE per panel mount (gated by `state.initialSyncDone`); the Refresh button does not re-fire it. Implemented in `loadConversations` in `src/panel/main.js` and the new pure helper `getActiveMuxyProject(muxy)` in `src/panel/project-change-listener.js`.
- **Stale-filter label on the picker button.** When the active Muxy project has no conversation history (the filter points to a project with no matches), the button now shows the abbreviated path (e.g. `…/scratch/cool` or `~/Repos/cool` when under `$HOME`) instead of the literal `All projects`. The previous behavior falsely implied "no filter is applied". The new behavior makes it clear that the panel is still scoped to a project — just one with no conversations yet. Implemented via the new pure helper `displayPathLabel(path, home, keepSegments=2)` in `src/panel/utils.js`.
- **Path abbreviation in the popover's PATHS section.** Long paths under `$HOME` are now shown as `~/foo`; longer paths are truncated to `…/last2` segments (e.g. `/Users/x/Repos/muxy-extensions/scratch/cool` → `…/scratch/cool`). The `displayPath` (full path) is unchanged and remains available as a hover tooltip. Implemented by passing `state.home` as the third arg to `buildPickerItems` in `src/panel/main.js`.

### Changed
- `getPickerLabel` in `src/panel/project-picker.js`: the "stale filter" case (last `return 'All projects';`) now returns `displayPathLabel(filterValue, home)`. The `null groups` and `empty groups` cases still return `All projects` since there is no path to abbreviate.
- `buildPickerItems` in `src/panel/project-picker.js`: added an optional `home = ''` parameter. `kind: 'path'` items now run their `label` through `displayPathLabel(label, home)` for compact popover labels. `kind: 'project'` items are unchanged (git repo basenames are already compact). `value`, `displayPath`, `active`, and `count` are unchanged so the picker behavior is preserved.
- `startPollingFallback` in `src/panel/project-change-listener.js`: refactored to share a private `_readRepoRoot(muxy)` helper with `getActiveMuxyProject`. Both paths now return byte-identical strings for the same Muxy state, so the `root === state.projectFilter` dedup at the polling call site works regardless of which helper updated the filter.
- Auto-follow polling interval lowered from 3000ms to 250ms (`POLL_INTERVAL_MS` in `src/panel/main.js`) so a project switch in Muxy is picked up faster.

## [0.9.1] - 2026-06-27

### Fixed
- **Auto-follow observability.** The v0.9.0 listener was effectively undebuggable from the panel because Muxy's debugger does not surface `console.log` from the panel iframe. The listener now reports its state via the panel's status bar (visible without DevTools): `Auto-follow: listening to <event>` on install, `Auto-follow: muxy.events unavailable` when `muxy.events.subscribe` is missing, `Auto-follow: no Muxy event worked, polling as fallback` when all 6 candidate event names are rejected, and `Filter synced: <basename>` every time the filter is applied.
- **Polling fallback that was promised in the v0.9.0 plan but not shipped.** When none of the 6 candidate event names are recognized by the user's Muxy version, a polling fallback activates automatically: it watches `muxy.git.repoInfo().root` on a 3-second interval and calls the same `onFilterChange` wrapper as the event helper. The algorithm is symmetric with the event helper (updates `lastActiveRoot` on every observed tick before the dedup check against `state.projectFilter`) to prevent thrash loops when the user manually picks a project via the picker.

### Added
- New export `startPollingFallback({muxy, state, onFilterChange, intervalMs=3000, setIntervalFn=globalThis.setInterval})` in `src/panel/project-change-listener.js`. Returns `{active: false}` when `muxy.git.repoInfo` is not a function; `{active: true, stop}` when polling is running. The first tick is a pure baseline capture (records the current root and returns) so the polling does not cause a redundant render when the panel mounts with a pre-existing filter. Transient `repoInfo` throws and buggy `onFilterChange` throws are both silently swallowed to keep the polling alive.
- 20 unit tests (17 cases) for the polling helper in `tests/test-project-listener.mjs`, including: baseline capture, root-change detection, dedup against `state.projectFilter`, no-thrash on manual pick, defensive `typeof` check, `repoInfo` throws, malformed payloads (`{}`, `{root: null}`, `{root: ''}`), `onFilterChange` throws, custom `intervalMs`, and `stop()` cleanup.

## [0.9.0] - 2026-06-27

### Changed
- **Auto-switch direction inverted.** The panel now follows Muxy's active project (Muxy → extension) instead of pushing project changes to Muxy (extension → Muxy). When you change the active project in Muxy, the panel filter updates automatically and the picker button reflects the new project.
- The detail view is preserved when Muxy switches projects while the user is reading a conversation: only `state.projectFilter` and the list re-render. The detail view reflects the new filter when the user navigates back.
- The helper `selectProjectAndFilter` is now purely a filter+render function: it hides the detail view, shows the list/filters/tabs, sets `state.projectFilter`, and calls `refreshPickerButton()` + `renderList()`. No Muxy API calls. No console diagnostics. Async signature kept for forward compatibility.

### Added
- New file `src/panel/project-change-listener.js` exporting pure helpers: `PROJECT_CHANGE_CANDIDATES` (a frozen list of 6 candidate event names: `project.changed`, `projects.active.changed`, `projects.current.changed`, `workspace.changed`, `repository.changed`, `git.changed`), `extractPathFromProjectEvent(event)` (returns the new path from the event payload or `null`), and `setupProjectChangeListener(deps)` (subscribes to all candidates and returns `{subscribed, failed}`). The wrapper in `main.js` provides the `onFilterChange` callback with the existing console diagnostic logging.
- New test suite `tests/test-project-listener.mjs` with 17 checks for the pure listener logic.

### Removed
- The `muxy.projects.switchTo` call from the project picker and the detail-view breadcrumb. These actions now only filter the local view; they do not change Muxy's active project.
- The 44 auto-switch acceptance checks from `tests/test-project-picker.mjs` (replaced by 14 checks for the simplified helper + 17 new checks in `tests/test-project-listener.mjs`).

### Notes
- The v0.8.0/v0.8.1 auto-switch attempted the extension → Muxy direction and was never released. The `muxy.projects.switchTo` call is still used by the `openInTerminal` flow (v0.5) to prepare the terminal's cwd — that use case is intentionally preserved.
- If none of the 6 candidate Muxy event names fire in your Muxy version, the listener logs `[ai-history] NO project-change event could be subscribed` at startup. Add the correct event name to `PROJECT_CHANGE_CANDIDATES` in `src/panel/project-change-listener.js`.

## [0.8.1] - 2026-06-27

### Fixed
- Auto-switch (v0.8.0) was too silent. The only feedback was a status bar message on success; the already-active case, the no-match case, and the error cases were completely silent. Every outcome now emits a status bar message (warn / err / ok) and every step of the auto-switch flow logs a `[ai-history]` diagnostic line to the console, so the user can see what happened in Muxy DevTools without having to guess.

## [0.8.0] - 2026-06-27

### Added
- Auto-switch to the selected project: choosing a project in the picker (or clicking a breadcrumb in the detail view) switches Muxy to that project when a matching one exists. The next "resume in terminal" then skips the project switch step. The switch is silent (status bar only).

## [0.7.0] - 2026-06-27

### Added
- Project picker popover with real-time search, grouped as **Projects** (git repos) and **Paths** (non-git), with a session-count badge per entry
- Click-to-resume: a primary click on a conversation card resumes the session in a terminal via the smart routing logic
- `Cmd+P` / `Ctrl+P` global shortcut to open the project picker from anywhere (does not require the panel to have focus)
- Clickable breadcrumb in the detail view — clicking a segment sets the project filter to that subpath and returns to the list
- **Copy path** action in the 3-dot menu (`navigator.clipboard.writeText`)
- Path abbreviation with `~` for `$HOME` paths in the list and picker; the absolute path is preserved in the tooltip
- New pure module `src/panel/project-picker.js` exporting 5 testable helpers: `filterGroups`, `getPickerLabel`, `buildPickerItems`, `matchItem`, `findActiveIndex`
- New pure helpers in `src/panel/utils.js`: `abbreviateHome`, `expandHome`, and an updated `decodeClaudeProject(project, home)` that resolves `~-`-encoded paths

### Changed
- The static `<select>`-based project filter is replaced with the searchable popover described above
- 3-dot menu: the "Open in Terminal" entry is removed (the same action is now triggered by a primary click on the card)
- 3-dot menu: **Copy path** is added
- Detail view: the meta line no longer shows the raw path — the path is now in the breadcrumb above the meta

### Fixed
- Project detection: cache invalidation on manual refresh (the smart routing was using stale sessions after a refresh)
- OpenCode sessions: `~` and `$HOME` expansion in the `directory` field (some rows stored the directory unexpanded, which broke the smart routing)
- `gitToplevel`: timeout increased from 4s to 6s, with diagnostic logging on unexpected exit codes
- Pre-existing startup crash: the `<select>`-based filter had a stale `addEventListener('change', ...)` that would have thrown once the DOM was removed

## [0.6.2] - 2026-XX-XX

### Fixed
- "Open in Terminal" was opening a terminal without switching the Muxy project or worktree. Root cause: missing `tabs:read` and `projects:read` permissions in the manifest. The flow silently fell through to the "no match" branch because `muxy.tabs.list()` and `muxy.projects.list()` were returning `permission denied`.

### Changed
- `openInTerminal` extracted from `main.js` into its own module `src/panel/open-in-terminal.js` with dependencies injected via a `deps` object. The wrapper in `main.js` passes the real Muxy object; the tests inject programmable mocks. This enables the 72 acceptance-criteria tests without a real Muxy host.
- Pre-check log of API availability rewritten to use `typeof x?.y` to avoid a pre-existing `TypeError` when `muxy.git.worktree` is `undefined`.

## [0.6.1] - 2026-XX-XX

### Added
- Detailed tagged logging (`[openInTerminal]`) at every step of the `openInTerminal` flow, emitted via two helpers (`olog` / `owarn`) so it is easy to grep in Muxy's extension log.

### Fixed
- `muxy.worktrees.switchTo(identifier, project)` — corrected to positional args (was being called with `{ project: projectId }`).
- `muxy.git.worktree.switchTo({ identifier })` — corrected to object form (was being called with a bare string).
- Added a verify pass after the worktree switch: re-read `muxy.git.repoInfo()` to confirm the active root actually changed.

## [0.6] - 2026-XX-XX

### Added
- "Open in Terminal" verifies whether the project is already open before opening a new one. The flow now (1) looks for an existing terminal in the project directory, (2) checks `muxy.projects.list()`, (3) switches to the matching project, (4) inspects worktrees, and (5) only then opens a new tab.

### Added (helpers)
- `findBestWorktreeForPath(worktrees, targetPath)` — longest-prefix match between worktrees and the target path.
- `isWorktreeActive(worktree, activePath)` — checks the `isActive` field with a path-match fallback.

## [0.5] - 2026-XX-XX

### Changed
- The `tabs.open` fallback in `openInTerminal` now auto-switches to the Muxy project that contains the conversation directory before opening the tab. The result is a terminal whose cwd matches the conversation, not the previously-active Muxy project.
- New `projects:write` permission added to the manifest to enable the project switch.

### Added (helpers)
- `pathInside(child, parent)` — strict path prefix match using the `/` separator (avoids `/foo/barx` matching `/foo/bar`).
- `findBestProjectForPath(projects, targetPath)` — picks the longest matching project; supports `path` / `root` / `directory` / `worktree` as field names.

## [0.4] - 2026-XX-XX

### Changed
- The "Export" entry in the 3-dot menu no longer opens a submenu that copies or saves directly to `~/Downloads/ai-history/`. It now opens a centered modal with a scrollable Markdown preview and explicit Copy / Save buttons.
- The Save button uses a `Blob` plus `<a download>` to trigger the native OS file picker (Finder on macOS), letting the user pick the destination.
- The modal can be dismissed with the `×` button, the `Esc` key, or a click on the backdrop.
- The preview reuses the already-loaded Markdown; the JSONL is not re-read when the modal opens.

## [0.3.1] - 2026-XX-XX

### Fixed
- **Open in Terminal:** Muxy rejected `tabs.open` calls that included a `directory` not inside the active worktree. The flow now tries with `directory` first, and falls back to opening without it (which uses the active Muxy project's cwd). A toast indicates when the fallback is used.
- **Copy as Markdown:** `printf '%s' ${JSON.stringify(markdown)}` was breaking on shell-special characters. The copy path now writes the Markdown to `/tmp` in base64 chunks and then pipes it to `pbcopy`.
- **Save as Markdown:** the heredoc-with-everything approach was hanging Muxy. The save path now uses base64-chunked writes followed by `base64 -d`, tested with payloads up to 1MB of Unicode and shell-special content.
- **Duplicate projects:** the same repo could appear twice in the project dropdown (once for Claude's encoded form, once for OpenCode's absolute form) or multiple times if subdirectories existed. `projectDisplayGroups` now dedupes by git toplevel and `extractRepoLabel` walks up parent directories.
