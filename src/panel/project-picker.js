// project-picker.js — Pure logic for the project filter popover.
// No DOM access, no `muxy` API. Receives data, returns data so the
// popover renderer in main.js can stay focused on DOM concerns.
//
// The module is composed of 5 small pure functions:
//   - filterGroups(groups, query)       — search the grouped projects
//   - getPickerLabel(filter, groups, home) — label for the picker button
//   - buildPickerItems(groups, filter)  — flat list ready to render
//   - matchItem(items, direction, start) — keyboard nav (arrow up/down)
//   - findActiveIndex(items)            — initial keyboard highlight

import { abbreviateHome } from './utils.js';

// ----- Internal helpers ------------------------------------------------------

// Returns true if `item` can receive keyboard highlight. Headers are
// non-selectable separators; 'all' / 'project' / 'path' are.
function isSelectableItem(item) {
  if (!item) return false;
  return item.kind === 'all' || item.kind === 'project' || item.kind === 'path';
}

// Returns true if any of `fields` on `item` contains `query` (case-insensitive).
// Non-string fields are skipped silently so the caller can pass extra metadata
// (e.g. `count`) without crashing.
function itemMatchesQuery(item, fields, q) {
  for (const f of fields) {
    const v = item[f];
    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
  }
  return false;
}

// ----- Public API ------------------------------------------------------------

/**
 * Filters the {git, nonGit} project groups by a case-insensitive search query.
 *
 * Matching fields:
 *   - Git items:    `label`, `displayPath`, `toplevel`
 *   - Non-git items: `label`, `displayPath`
 *
 * An empty or whitespace-only query returns ALL items. The returned
 * `git` and `nonGit` arrays are always NEW arrays (never the input
 * references) so callers can safely mutate them.
 *
 * @param {{git?: Array, nonGit?: Array} | null | undefined} groups
 *   Grouped projects (shape produced by `projectDisplayGroups`).
 * @param {string | null | undefined} query Search string (may be empty).
 * @returns {{git: Array, nonGit: Array}} New groups containing the matches.
 */
export function filterGroups(groups, query) {
  if (!groups || typeof groups !== 'object') return { git: [], nonGit: [] };
  const git = Array.isArray(groups.git) ? groups.git : [];
  const nonGit = Array.isArray(groups.nonGit) ? groups.nonGit : [];
  const q = (query == null ? '' : String(query)).trim().toLowerCase();
  if (!q) {
    return { git: [...git], nonGit: [...nonGit] };
  }
  return {
    git: git.filter((g) => itemMatchesQuery(g, ['label', 'displayPath', 'toplevel'], q)),
    nonGit: nonGit.filter((g) => itemMatchesQuery(g, ['label', 'displayPath'], q))
  };
}

/**
 * Returns the label to show on the picker button.
 *
 * Resolution order:
 *   1. Empty / null / undefined filter → "All projects".
 *   2. Filter matches a git group's `toplevel` or `project` → that group's `label`.
 *   3. Filter matches a non-git group's `project` or `displayPath` → the group's
 *      `label` with `~`-abbreviation applied (so e.g. `/Users/x/scratch`
 *      becomes `~/scratch` when `home === '/Users/x'`).
 *   4. Otherwise (stale filter) → "All projects".
 *
 * @param {string | null | undefined} filterValue Current `state.projectFilter`.
 * @param {{git?: Array, nonGit?: Array} | null | undefined} groups
 *   Current grouped projects.
 * @param {string} home Home directory used for `~`-abbreviation.
 * @returns {string} Picker button label.
 */
export function getPickerLabel(filterValue, groups, home) {
  if (!filterValue) return 'All projects';
  if (!groups || typeof groups !== 'object') return 'All projects';
  const git = Array.isArray(groups.git) ? groups.git : [];
  const nonGit = Array.isArray(groups.nonGit) ? groups.nonGit : [];
  for (const g of git) {
    if (filterValue === g.toplevel || filterValue === g.project) return g.label;
  }
  for (const g of nonGit) {
    if (filterValue === g.project || filterValue === g.displayPath) {
      return abbreviateHome(g.label, home);
    }
  }
  return 'All projects';
}

/**
 * Builds the flat list of items to render inside the popover, in display order:
 *
 *   [ all ] → [ projects header ] → [ project, project, ... ]
 *           → [ paths header ]    → [ path, path, ... ]
 *
 * Headers are omitted when the corresponding group is empty. If BOTH groups
 * are empty, the returned array still contains the `all` item so the popover
 * is never totally empty.
 *
 * Item shapes:
 *   - { kind: 'all',           label, value: '',   active }
 *   - { kind: 'project-header', label }
 *   - { kind: 'project',       value, label, displayPath, active, count? }
 *   - { kind: 'path-header',    label }
 *   - { kind: 'path',          value, label, displayPath, active, count? }
 *
 * `active` is set on at most ONE item — the one the filter currently
 * matches (or the `all` item when the filter is empty). Stale filters
 * leave all items with `active: false`.
 *
 * @param {{git?: Array, nonGit?: Array} | null | undefined} groups
 *   Project groups from `projectDisplayGroups`.
 * @param {string | null | undefined} currentFilter Current `state.projectFilter`.
 * @returns {Array<object>} Items ready for DOM rendering.
 */
export function buildPickerItems(groups, currentFilter) {
  const filter = currentFilter == null ? '' : String(currentFilter);
  const git = (groups && Array.isArray(groups.git)) ? groups.git : [];
  const nonGit = (groups && Array.isArray(groups.nonGit)) ? groups.nonGit : [];
  const items = [];
  items.push({ kind: 'all', label: 'All projects', value: '', active: filter === '' });
  if (git.length > 0) {
    items.push({ kind: 'project-header', label: `PROJECTS (${git.length})` });
    for (const g of git) {
      items.push({
        kind: 'project',
        value: g.toplevel,
        label: g.label,
        displayPath: g.displayPath,
        active: filter === g.toplevel || filter === g.project,
        count: g.count
      });
    }
  }
  if (nonGit.length > 0) {
    items.push({ kind: 'path-header', label: `PATHS (${nonGit.length})` });
    for (const g of nonGit) {
      items.push({
        kind: 'path',
        value: g.project || g.displayPath,
        label: g.label,
        displayPath: g.displayPath,
        active: filter === g.project || filter === g.displayPath,
        count: g.count
      });
    }
  }
  return items;
}

/**
 * Returns the index of the next selectable item for keyboard navigation
 * (ArrowUp / ArrowDown), wrapping around at both ends.
 *
 * Selectable kinds: `all`, `project`, `path`. Headers are skipped.
 *
 * Behavior:
 *   - `startIndex === -1` + direction 'down' → first selectable
 *   - `startIndex === -1` + direction 'up'   → last selectable
 *   - `startIndex >= 0`  + direction 'down' → next selectable after it
 *   - `startIndex >= 0`  + direction 'up'   → previous selectable before it
 *   - If startIndex points to a header (not selectable), the search still
 *     starts just past/before it — the header is transparent to navigation.
 *   - Returns `-1` if the list is empty or has no selectable items.
 *
 * The second argument is named `direction` (not `query`) — the caller is
 * expected to filter `items` via `filterGroups` + `buildPickerItems` first.
 *
 * @param {Array<object>} items Items from `buildPickerItems`.
 * @param {'down' | 'up'} direction Arrow key direction.
 * @param {number} startIndex Current highlighted index, or `-1` for none.
 * @returns {number} Next selectable index, or `-1` if none exists.
 */
export function matchItem(items, direction, startIndex) {
  if (!Array.isArray(items) || items.length === 0) return -1;
  const firstSelectable = () => {
    for (let i = 0; i < items.length; i += 1) {
      if (isSelectableItem(items[i])) return i;
    }
    return -1;
  };
  const lastSelectable = () => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (isSelectableItem(items[i])) return i;
    }
    return -1;
  };
  if (!Number.isFinite(startIndex) || startIndex < 0) {
    return direction === 'up' ? lastSelectable() : firstSelectable();
  }
  if (direction === 'down') {
    for (let i = startIndex + 1; i < items.length; i += 1) {
      if (isSelectableItem(items[i])) return i;
    }
    return firstSelectable();
  }
  if (direction === 'up') {
    for (let i = startIndex - 1; i >= 0; i -= 1) {
      if (isSelectableItem(items[i])) return i;
    }
    return lastSelectable();
  }
  return -1;
}

/**
 * Returns the index of the currently-active item in `items`, or `-1` if none.
 * Used to initialize the keyboard highlight when the popover opens.
 *
 * Items already carry the `active` flag set by `buildPickerItems`, so this
 * function simply scans for the first `active === true`. The `currentFilter`
 * parameter is accepted to match the public API but is intentionally unused
 * — pass it for forward-compatibility (a future version may re-derive
 * `active` from it).
 *
 * @param {Array<object>} items Items from `buildPickerItems`.
 * @param {string} [currentFilter] Unused; kept for API stability.
 * @returns {number} Index of the active item, or `-1` if none.
 */
export function findActiveIndex(items, currentFilter) {
  if (!Array.isArray(items)) return -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] && items[i].active === true) return i;
  }
  return -1;
}

// ----- Auto-switch helper -----------------------------------------------------

// selectProjectAndFilter — extracted from main.js for testability.
// All Muxy API access and DOM side effects are injected via `deps`.
//
// deps = {
//   state,                        // shared state object (mutated in place)
//   muxy,                         // Muxy API (or mock)
//   els,                          // DOM element refs
//   refreshPickerButton,          // () => void
//   renderList,                   // () => void
//   setStatus,                    // (text, kind) => void
//   findBestProjectForPath,       // (projects, path) => project | null
//   isProjectActive,              // ({muxy, pathInside}, project) => boolean
//   pathInside                    // (child, parent) => boolean
// }
//
// Returns a Promise<void>.
//
// Behavior:
//   1. Switches to the list view (hides detail, shows conversations, tabs, filters).
//   2. Applies the filter synchronously (state.projectFilter, state.page, renderList).
//   3. Best-effort auto-switch to the matching Muxy project via
//      muxy.projects.list → findBestProjectForPath → muxy.projects.switchTo.
//      The filter is always applied regardless of switch outcome. All outcomes
//      emit a status bar message (status bar only, no toast) except the
//      'muxy.projects missing' case which is an environment limitation.
//      Diagnostic [ai-history] log lines are emitted at each step for the
//      user to inspect in Muxy DevTools.
export async function selectProjectAndFilter(deps, path) {
  const {
    state, muxy, els,
    refreshPickerButton, renderList, setStatus,
    findBestProjectForPath, isProjectActive, pathInside
  } = deps;

  // 1. Switch to the list view
  state.currentDetail = null;
  if (els.detail) els.detail.classList.add('hidden');
  if (els.conversations) els.conversations.classList.remove('hidden');
  const filtersEl = els.filters || (typeof document !== 'undefined' ? document.querySelector('.filters') : null);
  const tabsEl = els.tabs || (typeof document !== 'undefined' ? document.querySelector('.tabs') : null);
  if (filtersEl) filtersEl.classList.remove('hidden');
  if (tabsEl) tabsEl.classList.remove('hidden');

  // 2. Apply filter (synchronous, immediate UI update)
  state.projectFilter = path || '';
  state.page = 1;
  refreshPickerButton();
  renderList();

  // 3. Auto-switch (best-effort, always reported). Filter is already applied.
  if (!path) {
    console.log('[ai-history] auto-switch skipped: empty path');
    return;
  }
  if (typeof muxy === 'undefined' || !muxy.projects ||
      typeof muxy.projects.list !== 'function') {
    console.warn('[ai-history] auto-switch skipped: muxy.projects.list unavailable');
    return;
  }
  let projects;
  try {
    projects = await muxy.projects.list();
  } catch (e) {
    console.warn('[ai-history] auto-switch: projects.list failed', e);
    setStatus(`Auto-switch failed: ${e.message || String(e)}`, 'error');
    return;
  }
  const match = findBestProjectForPath(projects, path);
  if (!match) {
    console.log(`[ai-history] auto-switch: no Muxy project matches "${path}" (${projects.length} projects available)`);
    setStatus(`No Muxy project matches ${path}`, 'warn');
    return;
  }
  if (isProjectActive({ muxy, pathInside }, match)) {
    console.log(`[ai-history] auto-switch: already in ${match.name || match.path}`);
    setStatus(`Already in ${match.name || match.path}`, 'ok');
    return;
  }
  if (typeof muxy.projects.switchTo !== 'function') {
    console.warn('[ai-history] auto-switch: muxy.projects.switchTo not a function');
    setStatus('Auto-switch unavailable: switchTo not exposed', 'error');
    return;
  }
  const id = match.id || match.name || match.path;
  try {
    await muxy.projects.switchTo(id);
    console.log(`[ai-history] auto-switch: switched to ${match.name || match.path} (id=${id})`);
    setStatus(`Switched to ${match.name || match.path}`, 'ok');
  } catch (e) {
    console.warn('[ai-history] auto-switch: switchTo failed', e);
    setStatus(`Auto-switch failed: ${e.message || String(e)}`, 'error');
  }
}
