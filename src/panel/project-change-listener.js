import { isWorktreeActive } from './utils.js';

// project-change-listener.js — Pure helpers for the Muxy project-change listener.
//
// Extracted from main.js so the listener's logic can be unit-tested without a
// running Muxy host. The helper is pure-ish: it takes its dependencies via the
// `deps` object and does not touch `muxy` or `console` directly. The caller
// (main.js) wraps it with the diagnostic logging.
//
// Exposes:
//   - PROJECT_CHANGE_CANDIDATES  — frozen list of event names to try, in order
//   - extractPathFromProjectEvent — resolve the new project path from a payload
//   - setupProjectChangeListener  — install all candidate subscriptions

// Candidate Muxy event names for project changes. Muxy docs do not enumerate
// runtime events, so we try the most common conventions. The first one that
// successfully subscribes is treated as the canonical one; the rest are kept
// in the list to maximize compatibility with future Muxy versions but the
// `setupProjectChangeListener` return value lets the caller log them as
// "skip extra" so we don't double-fire.
//
// Frozen at module load so accidental in-place mutation is a hard error.
// To add a new candidate, edit the source list directly.
export const PROJECT_CHANGE_CANDIDATES = Object.freeze([
  'project.changed',
  'projects.active.changed',
  'projects.current.changed',
  'workspace.changed',
  'repository.changed',
  'git.changed'
]);

// Resolves the new project path from a Muxy project-change event payload.
// Tries (in order): event.project.path, event.path, event.root. Returns
// `null` if the event is null/undefined, or if none of the three fields is
// present or is an empty string (empty strings are treated as missing — a
// payload with `{ project: { path: '' } }` carries no useful information).
export function extractPathFromProjectEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [event?.project?.path, event?.path, event?.root];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Installs the project-change listener on the given Muxy host. For each
// candidate event name, attempts to subscribe a callback that resolves the
// new path and invokes `onFilterChange(newPath)` when the path differs from
// the current filter.
//
// `deps` = { muxy, state, onFilterChange }
//   - muxy          : the Muxy host (may be undefined in tests)
//   - state         : the panel state; the helper reads `state.projectFilter`
//   - onFilterChange: invoked as `onFilterChange(newPath)` on every relevant event
//
// Returns { subscribed, failed }:
//   - subscribed : names of the events that got a live subscription
//   - failed     : names of the events whose `subscribe` call threw
//
// If `muxy`, `muxy.events`, or `muxy.events.subscribe` is missing/non-callable,
// the helper returns `{ subscribed: [], failed: [] }` without throwing — the
// caller decides how to surface that (warn, no-op, etc).
export function setupProjectChangeListener(deps) {
  const { muxy, state, onFilterChange } = deps || {};
  if (!muxy || !muxy.events || typeof muxy.events.subscribe !== 'function') {
    return { subscribed: [], failed: [] };
  }

  const subscribed = [];
  const failed = [];
  for (const eventName of PROJECT_CHANGE_CANDIDATES) {
    try {
      muxy.events.subscribe(eventName, (event) => {
        const newPath = extractPathFromProjectEvent(event);
        if (!newPath) return;
        if (newPath === state.projectFilter) return;
        onFilterChange(newPath);
      });
      subscribed.push(eventName);
    } catch (e) {
      failed.push(eventName);
    }
  }
  return { subscribed, failed };
}

// Reads the active Muxy project root from `muxy.git.repoInfo().root`, with
// full defensive coverage for every shape the Muxy host can return. Returns
// the root string when present, or `''` for any of the failure modes below.
//
// Used by:
//   - `getActiveMuxyProject(muxy)` (panel-mount sync) — needs the same root
//     string that the polling fallback would extract, byte-identical, so the
//     `root === state.projectFilter` dedup at the polling call site does not
//     false-positive on a cosmetic string difference.
//   - `startPollingFallback` (auto-follow listener) — uses the helper inside
//     the per-tick callback. The try/catch wrapper around `muxy.git.repoInfo()`
//     stays in the polling helper so transient errors don't kill polling.
//
// Returns `''` (NOT `null` or `undefined`) for:
//   - `muxy` is undefined / null
//   - `muxy.git` is undefined / null
//   - `muxy.git.repoInfo` is not a function (or missing)
//   - `muxy.git.repoInfo()` throws (callers should still call this from a
//     try/catch if they need that defensive behavior — this helper itself
//     does NOT swallow throws so the caller can distinguish "no project"
//     from "Muxy is broken")
//   - `repoInfo()` returns null / undefined / non-object
//   - `info.root` is missing / null / non-string / empty string
//
// Empty-string normalization is intentional: it lets callers use
// `if (!root)` as a single check, the same as they would for an absent
// project, and matches the polling helper's pre-refactor contract.
export function _readRepoRoot(muxy) {
  if (!muxy || !muxy.git || typeof muxy.git.repoInfo !== 'function') {
    return '';
  }
  const info = muxy.git.repoInfo();
  if (!info || typeof info !== 'object') return '';
  const root = info.root;
  if (typeof root !== 'string' || root.length === 0) return '';
  return root;
}

// Returns the active Muxy project root (from `muxy.git.repoInfo().root`) or
// `''` when no project is active / Muxy is unavailable. The returned string
// is byte-identical to what the polling fallback's tick would extract, so
// the two helpers can be compared with `===` without false negatives.
//
// Used at panel mount to sync `state.projectFilter` to the active project
// ONE TIME — gated by `state.initialSyncDone` so a Refresh click does not
// re-fire the sync.
//
// Failure modes (all return `''`):
//   - `muxy` is undefined / null
//   - `muxy.git` is undefined / null
//   - `muxy.git.repoInfo` is not a function
//   - `muxy.git.repoInfo()` throws (caught here so the call site is safe
//     even if the Muxy host is in a bad state)
//   - payload is null / non-object
//   - `info.root` is missing / null / non-string / empty
//
// Throws: never. The defensive try/catch keeps panel mount from crashing
// if Muxy is unavailable.
export function getActiveMuxyProject(muxy) {
  try {
    return _readRepoRoot(muxy);
  } catch {
    return '';
  }
}

// Fallback source for the active project path: `muxy.git.repoInfo()` only
// reports a root when the currently-focused Muxy tab is itself a git-scoped
// terminal. It returns `{}` when the focused tab is something else (e.g. an
// extension panel, or a non-terminal tab) even though Muxy's own project
// switcher has an active project selected. `muxy.projects.list()` carries
// that selection directly via each project's `isActive` boolean, so this is
// used whenever `_readRepoRoot` comes back empty.
//
// Returns the active project's `path`, or `''` when unavailable (missing
// API, non-array response, no project with `isActive === true`, or a
// throw from `list()`).
export async function getActiveProjectPath(muxy) {
  if (!muxy || !muxy.projects || typeof muxy.projects.list !== 'function') return '';
  try {
    const projects = await muxy.projects.list();
    if (!Array.isArray(projects)) return '';
    const active = projects.find((p) => p && p.isActive === true);
    if (!active || typeof active.path !== 'string' || active.path.length === 0) return '';
    // If the user has navigated into a worktree of this project, prefer its
    // path over the main project path so the panel filter follows the
    // worktree, not just the parent repo. `muxy.worktrees.list` is tried
    // first, `muxy.git.worktrees` as a fallback — same lookup order used by
    // the "Open in Terminal" flow (open-in-terminal.js) for this Muxy API.
    const rawListFn = (muxy.worktrees && typeof muxy.worktrees.list === 'function')
      ? muxy.worktrees.list.bind(muxy.worktrees)
      : (muxy.git && typeof muxy.git.worktrees === 'function')
        ? muxy.git.worktrees.bind(muxy.git)
        : null;
    if (!rawListFn) return active.path;
    // The `id` must be passed POSITIONALLY — `{ project: id }` makes at
    // least one real Muxy build throw "project not found [object Object]"
    // (the whole options object gets stringified as the lookup key).
    // Confirmed working: `rawListFn(active.id)`. The other two shapes are
    // kept as fallbacks for other Muxy versions that might expect them.
    const attempts = [
      () => rawListFn(active.id),
      () => rawListFn({ project: active.id }),
      () => rawListFn()
    ];
    for (const call of attempts) {
      try {
        const worktrees = await call();
        if (!Array.isArray(worktrees)) continue;
        const activeWt = worktrees.find((w) => isWorktreeActive(w, active.path));
        const wtPath = activeWt && (activeWt.path || activeWt.root || activeWt.directory);
        return (typeof wtPath === 'string' && wtPath.length > 0) ? wtPath : active.path;
      } catch {
        // try the next call shape
      }
    }
    return active.path;
  } catch {
    return '';
  }
}

// Polling fallback for the project-change listener. When none of the Muxy
// event-name candidates in PROJECT_CHANGE_CANDIDATES work (the user's Muxy
// version uses a different event name), this helper watches
// `muxy.git.repoInfo().root` on an interval and invokes `onFilterChange`
// whenever the active root changes.
//
// The algorithm is SYMMETRIC with the event helper above:
//   - On every tick, capture the current root.
//   - If it equals the last seen root → no change, skip.
//   - Otherwise, ALWAYS update `lastActiveRoot` (this prevents thrash when
//     the user manually picks a project in the picker: the closure would
//     otherwise see "root != lastActiveRoot" forever and fire every tick).
//   - If the new root equals `state.projectFilter` → already in sync, skip.
//   - Otherwise call `onFilterChange(newRoot)`.
//
// The root extraction is delegated to `_readRepoRoot(muxy)` so the polling
// fallback and `getActiveMuxyProject(muxy)` return byte-identical strings
// for the same Muxy state. The `try { ... } catch { return; }` wrapper
// around `muxy.git.repoInfo()` stays in this helper — `_readRepoRoot` lets
// the throw escape so mount-time callers (which never want to crash panel
// boot) must wrap it in their own try/catch, but the polling tick is fine
// swallowing it inline because the spec is "transient errors don't kill
// polling".
//
// `setIntervalFn` and `intervalMs` are injectable for tests.
//
// Returns { active: boolean, stop?: () => void }.
//   - { active: false } when muxy.git.repoInfo is unavailable.
//   - { active: true, stop } when polling is running.
export function startPollingFallback({
  muxy,
  state,
  onFilterChange,
  intervalMs = 3000,
  setIntervalFn = globalThis.setInterval
} = {}) {
  // Defensive: bail if repoInfo is not a function (Reviewer m5).
  if (!muxy || !muxy.git || typeof muxy.git.repoInfo !== 'function') {
    return { active: false };
  }
  let lastActiveRoot = null;  // baseline; first tick captures only
  let firstTick = true;        // skip fire on the very first tick
  // Shared by both root sources (repoInfo and the projects.list() fallback)
  // so "last known active path" and the dedup/baseline logic stay unified
  // regardless of which one produced the value.
  const applyRoot = (root) => {
    if (!root) return;
    if (firstTick) {
      // Pure baseline capture: record the current root and exit. Do NOT
      // fire onFilterChange even if root !== state.projectFilter — at
      // install time we don't know if the panel was just mounted with a
      // pre-existing filter, and firing would cause a redundant render.
      firstTick = false;
      lastActiveRoot = root;
      return;
    }
    if (root === lastActiveRoot) return;
    lastActiveRoot = root; // ALWAYS update before the dedup check
    if (root === state.projectFilter) return; // user already there
    try {
      onFilterChange(root);
    } catch {
      // silent: a buggy render in onFilterChange must not kill polling (Reviewer m3)
    }
  };
  const handle = setIntervalFn(() => {
    let root;
    try {
      root = _readRepoRoot(muxy);
    } catch {
      return; // silent: transient errors don't kill polling (Reviewer m1)
    }
    if (root) {
      applyRoot(root);
      return;
    }
    // repoInfo yielded nothing (no project active, malformed payload, or —
    // most commonly — the focused tab isn't a git-scoped terminal even
    // though Muxy's project switcher has an active project). Fall back to
    // `muxy.projects.list()`'s `isActive` project. Only attempted when the
    // API is present so hosts/tests without `muxy.projects` are unaffected.
    if (typeof muxy?.projects?.list === 'function') {
      getActiveProjectPath(muxy).then(applyRoot).catch(() => {});
    }
  }, intervalMs);
  return {
    active: true,
    stop: () => {
      // Best-effort cleanup. Works for both real setInterval (returns a
      // number) and any test mock that implements clearInterval.
      if (typeof globalThis.clearInterval === 'function' && handle != null) {
        globalThis.clearInterval(handle);
      }
    }
  };
}
