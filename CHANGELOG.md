# Changelog

All notable changes to AI History are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
