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
