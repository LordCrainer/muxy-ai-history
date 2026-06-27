# AI History — Muxy Extension

A unified viewer for Claude Code and OpenCode session history inside Muxy.

## Overview

AI History reads the on-disk session stores of Claude Code and OpenCode and exposes them as a single, searchable list inside Muxy's right-side panel. Each card represents one conversation; the user can resume the session in a terminal, view its messages, rename it, export it as Markdown, or copy the project path. Custom titles, project filtering, and subpath navigation are all handled client-side with no background services and no network calls.

## Features

### Browse
- Unified list of Claude Code and OpenCode sessions
- Filter by provider (All / Claude / OpenCode)
- Filter by project via a searchable popover, grouped as **Projects** (git repos) and **Paths** (non-git)
- Real-time search across title, message content, and project path
- Pagination at 50 sessions per page with a "Load more" affordance

### Interact
- Primary click on a card resumes the session in a terminal (smart routing — reuses an existing tab if one is open)
- Cmd/Ctrl+Click opens the message detail view
- 3-dot menu on each card: **View**, **Copy path**, **Export** (Copy / Save as Markdown), **Rename**
- Clickable breadcrumb in the detail view — clicking any segment filters the list to that subpath
- Selecting a project in the picker (or clicking a detail-view breadcrumb) auto-switches Muxy to that project when a match exists, so the next "resume in terminal" skips the project-switch step. Silent (status bar only).

### Modify
- Rename a session inline; writes through to the source (SQL for OpenCode, sidecar JSON for Claude Code)
- Export as Markdown: copy to the clipboard, or save as a `.md` file via the native OS file picker
- Copy the absolute project path to the clipboard

### UX details
- Paths under `$HOME` are shown with a `~` prefix; the absolute path is in the tooltip (`title` attribute)
- Custom titles override the default per session and persist

## How it works

When the panel opens, AI History reads the data sources for both providers and parses them into a single list of conversation objects. Claude Code's JSONL files are read with `cat`; OpenCode's SQLite store is read with `sqlite3`. After that initial read, the list is filtered, searched, and sorted in memory; no further disk I/O happens until the user takes an action (view, rename, export, or resume).

All I/O goes through Muxy's `muxy.exec` shim — there is no Node binding, no background daemon, and no network access. The panel runs entirely in Muxy's right-side panel sandbox; the host process only sees the API calls listed in [API used](#api-used).

## Project structure

```
ai-history/
├── package.json                   # Muxy manifest (commands, permissions, panel config)
├── vite.config.js                 # Vite build config with the fixup-output plugin
├── src/
│   ├── panel/
│   │   ├── panel.html             # Entry HTML (button, popover, modal containers)
│   │   ├── main.js                # UI logic, state, I/O orchestration, event wiring
│   │   ├── utils.js               # Pure helpers (format, escape, project grouping, home expansion)
│   │   ├── open-in-terminal.js    # Smart routing logic (deps-injected, testable in isolation)
│   │   ├── project-picker.js      # Pure helpers for the project picker popover
│   │   └── styles.css             # Dark theme styles (panel, cards, menu, picker, modal)
│   └── assets/
│       └── icon.svg               # Topbar icon
├── tests/
│   ├── test-parsers.mjs           # Source and bundle smoke tests
│   ├── test-chunked-write.mjs     # Round-trip of the chunked base64 writer
│   ├── test-open-in-terminal.mjs  # 12 acceptance criteria for the routing logic
│   └── test-project-picker.mjs    # The 5 pure helpers in project-picker.js
└── dist/                          # Vite build output + copied manifest
    ├── panel.html
    ├── package.json
    ├── icon.svg
    └── assets/
        ├── panel-*.js
        └── panel-*.css
```

## Data sources

| Provider    | Path                                       | Format  |
| ----------- | ------------------------------------------ | ------- |
| Claude Code | `~/.claude/projects/<encoded>/<id>.jsonl`  | JSONL   |
| OpenCode    | `~/.local/share/opencode/opencode.db`      | SQLite  |

Claude Code encodes project paths in its directory names (`-Users-x-Repos-ac` for `/Users/x/Repos/ac`); the extension decodes them back with `decodeClaudeProject`. OpenCode stores sessions in three tables — `session` (id, title, directory, timestamps), `message` (one row per message), and `part` (one row per text, tool, or reasoning fragment) — which the panel joins in a single `sqlite3 -json` query.

## Custom titles

- **OpenCode** — the new title is written directly to `session.title` via a SQL `UPDATE`. The change persists immediately and is visible in any other client that reads the same SQLite file.
- **Claude Code** — Claude has no editable title field, so the extension uses a sidecar JSON file at `~/.config/muxy/extensions/ai-history/custom-titles.json`. The format is `{"claude:<session-id>": "new title"}`. Deleting the sidecar reverts all custom titles.

## Resume in terminal

The smart routing lives in `src/panel/open-in-terminal.js`. When the user clicks a card, AI History:

1. Looks up the absolute project directory from the conversation record.
2. Checks `muxy.tabs.list()` and switches to an existing terminal if one is already in that directory.
3. Calls `muxy.projects.list()` and uses `findBestProjectForPath` to pick the most specific Muxy project that contains the conversation; switches to it if not active.
4. Calls `muxy.worktrees.list()` (with `muxy.git.worktrees()` as fallback), finds the worktree whose path contains the conversation, and switches to it — then re-reads `muxy.git.repoInfo()` to verify the switch actually took effect.
5. Opens a new terminal tab with `claude --resume <id>` (Claude Code) or `opencode -s <id>` (OpenCode) wrapped in a `cd "<projectDir>" && ...` shell expression. If Muxy rejects the `directory` parameter, the flow falls back to opening in the active Muxy project's cwd.

The same flow is used whether the trigger is the primary click on a card or the (legacy) "Open in Terminal" menu item.

## Project picker

The project filter is a popover anchored to a button in the list header. It groups projects into **Projects** (git repos, deduped by toplevel) and **Paths** (non-git absolute paths), and shows a session count next to each entry. The search field is case-insensitive and matches against label, display path, and toplevel. The list is keyboard-navigable: `↑/↓` move the highlight, `Enter` selects, `Esc` closes, and headers are skipped during navigation. `Cmd+P` / `Ctrl+P` toggles the popover from anywhere — the panel does not need focus.

## Path abbreviation

Paths under `$HOME` are rendered with a `~` prefix to reduce visual noise (for example, `/Users/x/Repos/ac` shows as `~/Repos/ac`); the absolute path is still present as a `title` attribute and surfaces as a native browser tooltip on hover. The two helpers `abbreviateHome` and `expandHome` in `src/panel/utils.js` are mirror functions: the first collapses `$HOME` prefixes, the second expands `~`, `~/`, and `$HOME` back to absolute paths. `expandHome` is also used internally to normalize OpenCode session directories before the smart routing logic runs, because some rows store the directory as `~/foo` rather than an absolute path.

## Privacy

- **Reads from** `~/.claude/projects/` (Claude Code) and `~/.local/share/opencode/opencode.db` (OpenCode).
- **Writes to** `~/.config/muxy/extensions/ai-history/custom-titles.json` (the Claude Code custom-titles sidecar) and in-place to OpenCode's SQLite (for OpenCode renames).
- **Network:** zero outbound network calls. No telemetry, no analytics, no remote logging.
- All processing happens in the panel browser process (the Muxy sandbox); no data leaves the host.
- Permissions are scoped (see [Manifest permissions](#manifest-permissions)) and explicitly listed in the extension manifest.
- No data is shared with third parties. The user is the only consumer.

## Manifest permissions

| Permission                       | Why it is needed                                       |
| -------------------------------- | ------------------------------------------------------ |
| `panels:write`                   | Render the panel UI                                    |
| `notifications:write`            | Toast notifications (action feedback)                  |
| `tabs:read`, `tabs:write`        | Open or reuse terminal tabs                            |
| `git:read`                       | Detect the active worktree (for `tabs.open`)           |
| `projects:read`, `projects:write`| Switch to the project that owns the session            |
| `commands:exec`                  | `cat`, `sqlite3`, `mkdir`, `printf`, `base64`, `pbcopy`, `git` |

## Manifest commands
- `toggle-history` (Cmd+Shift+H) — open or close the panel
- `refresh-history` — reload the session list (command palette only)

## API used

Grouped by purpose. The exact list is enumerated in `src/panel/main.js`.

- **File / shell I/O** — `muxy.exec(["/bin/cat", file])` for JSONL, `muxy.exec(["/usr/bin/sqlite3", "-json", db, sql])` for OpenCode queries, `muxy.exec(["/usr/bin/sqlite3", db, updateSql])` for OpenCode renames, `muxy.exec(["/bin/mkdir", "-p", dir])` for export directories, chunked `muxy.exec(["/bin/sh", "-c", "printf '%s' '...' >> /tmp/..."])` followed by `muxy.exec(["/bin/sh", "-c", "base64 -d < /tmp/... > PATH"])` for large writes.
- **Projects** — `muxy.projects.list()`, `muxy.projects.switchTo(identifier)`.
- **Worktrees** — `muxy.worktrees.list({ project })`, `muxy.worktrees.switchTo(identifier, project)`; fallback to `muxy.git.worktrees()` and `muxy.git.worktree.switchTo({ identifier })`.
- **Git** — `muxy.git.repoInfo()` to detect the active worktree.
- **Tabs** — `muxy.tabs.list()`, `muxy.tabs.switchTo(idOrIndex)`, `muxy.tabs.open({ kind, command, directory, singleton })`.
- **UI** — `muxy.toast({ title, body, variant })` (variant: `info` | `error` | `success` | `warn`); `muxy.events.subscribe('command.refresh-history', ...)` for palette-driven refresh.
- **Browser** — `navigator.clipboard.writeText(text)` for the clipboard actions.

## Development

The project uses [bun](https://bun.sh) for package management and script
execution. `bun.lock` is the source of truth; `package-lock.json` is kept for
npm users but is regenerated as a side effect.

### Setup

```bash
git clone <repo>
cd ai-history
bun install
```

> If you do not have bun, `npm install` works too — both lockfiles are
> committed and the scripts are runtime-agnostic.

### Run

- `bun run dev` — Vite dev server on port 5173
- `bun run build` — produces `dist/` (Vite bundle + manifest copy)
- `bun run test` — runs all 4 test suites (654 tests)
- `bun run test:oit` — runs only the `open-in-terminal` suite
- `bun run test:picker` — runs only the `project-picker` suite

> Equivalents for npm users: `npm run dev`, `npm run build`, `npm test`, etc.

### Architecture
- `src/panel/main.js` — UI logic, state management, I/O orchestration, and event wiring. Imports the pure helpers from `utils.js` and `project-picker.js`, and the dependency-injected routing function from `open-in-terminal.js`.
- `src/panel/utils.js` — pure helpers (formatting, escaping, project grouping, `~`-expansion, path matching, worktree selection). No DOM access, no Muxy API references; safe to import from Node tests.
- `src/panel/open-in-terminal.js` — the smart routing logic. All Muxy API access and side effects are injected via a `deps` object so the module is unit-testable in isolation.
- `src/panel/project-picker.js` — pure helpers for the project picker popover: `filterGroups`, `getPickerLabel`, `buildPickerItems`, `matchItem`, `findActiveIndex`.
- `src/panel/panel.html` — entry HTML (button, popover, modal containers).
- `src/panel/styles.css` — dark theme styles for the panel, cards, menu, picker, breadcrumb, and modal.

## Keyboard shortcuts

| Shortcut               | Action                                  |
| ---------------------- | --------------------------------------- |
| Cmd+Shift+H            | Toggle the panel                        |
| Cmd+P / Ctrl+P         | Open the project picker (global)        |
| Esc                    | Close popover, menu, or modal           |
| Enter (in rename)      | Save the new title                      |
| Cmd/Ctrl+Click on card | Open the message detail view            |

## Troubleshooting

| Issue                                  | Fix                                                |
| -------------------------------------- | -------------------------------------------------- |
| "permission denied" on first run       | Reload the extension and accept the consent prompt |
| "Allow this command to run?" each time | Click "Allow & remember" on the first prompt       |
| OpenCode rename not visible elsewhere  | Expected — OpenCode uses direct SQL updates       |
| Custom title missing in Claude         | Verify the sidecar file is not corrupted           |

For deeper diagnosis of the "Open in Terminal" flow, enable verbose logging in Muxy's extension log and search for the `[openInTerminal]` tag.

## Tests

654 tests across 4 suites. Run with `npm test`. See [CHANGELOG.md](./CHANGELOG.md) for version history.

| Suite                              | Tests | What it covers                                |
| ---------------------------------- | ----- | --------------------------------------------- |
| `tests/test-parsers.mjs`           | 424   | Source and bundle smoke tests                 |
| `tests/test-chunked-write.mjs`     | 20    | Round-trip of the chunked base64 writer       |
| `tests/test-open-in-terminal.mjs`  | 72    | 12 acceptance criteria for the routing logic  |
| `tests/test-project-picker.mjs`    | 138   | The 5 pure helpers in `project-picker.js`      |

The routing tests use a programmable Muxy mock factory (`createMuxyMock()`) that records every API call and lets you inject responses per key, so no real Muxy host is required.

## Bundle size

~42KB raw / ~13KB gzipped. Vite + vanilla JS, no frameworks.

## License

See [LICENSE](./LICENSE).
