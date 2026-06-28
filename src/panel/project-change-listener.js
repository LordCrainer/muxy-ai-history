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
  const handle = setIntervalFn(() => {
    let info;
    try {
      info = muxy.git.repoInfo();
    } catch {
      return; // silent: transient errors don't kill polling (Reviewer m1)
    }
    const root = info && typeof info === 'object' ? info.root : null;
    if (typeof root !== 'string' || root.length === 0) {
      return; // malformed payload: skip tick (Reviewer m2)
    }
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
