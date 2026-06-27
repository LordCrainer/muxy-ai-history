// Test script: project picker pure logic
// Usage: node tests/test-project-picker.mjs
//
// Covers the 5 exported functions in src/panel/project-picker.js:
//   - filterGroups
//   - getPickerLabel
//   - buildPickerItems
//   - matchItem
//   - findActiveIndex
//
// All functions are pure, so the tests need no DOM, no Muxy API, and no
// fixtures on disk. Inputs and expected outputs are constructed inline.

import { homedir } from 'os';

import {
  filterGroups,
  getPickerLabel,
  buildPickerItems,
  matchItem,
  findActiveIndex
} from '../src/panel/project-picker.js';

const HOME = homedir();

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

console.log('AI History - Project Picker Tests\n');

// ---- Fixtures ---------------------------------------------------------------

// Two git groups (repos) and two non-git groups (scratch dirs).
// Git items: project === toplevel, label is the basename.
// Non-git items: project is the raw absolute path, label is the full path.
const GROUPS = {
  git: [
    {
      project: '/Users/x/Repos/muxy-extensions',
      label: 'muxy-extensions',
      isGit: true,
      toplevel: '/Users/x/Repos/muxy-extensions',
      displayPath: '/Users/x/Repos/muxy-extensions',
      count: 5
    },
    {
      project: '/Users/x/Repos/ai-history',
      label: 'ai-history',
      isGit: true,
      toplevel: '/Users/x/Repos/ai-history',
      displayPath: '/Users/x/Repos/ai-history',
      count: 3
    }
  ],
  nonGit: [
    {
      project: '/Users/x/scratch',
      label: '/Users/x/scratch',
      isGit: false,
      toplevel: null,
      displayPath: '/Users/x/scratch',
      count: 2
    },
    {
      project: '/tmp/scratch',
      label: '/tmp/scratch',
      isGit: false,
      toplevel: null,
      displayPath: '/tmp/scratch',
      count: 1
    }
  ]
};

// ---- 1. filterGroups --------------------------------------------------------

console.log('1. filterGroups');
{
  // Empty / whitespace query → returns all items
  const r1 = filterGroups(GROUPS, '');
  check('empty query: git count matches', r1.git.length === GROUPS.git.length, `got ${r1.git.length}`);
  check('empty query: nonGit count matches', r1.nonGit.length === GROUPS.nonGit.length, `got ${r1.nonGit.length}`);

  const r2 = filterGroups(GROUPS, '   \t\n  ');
  check('whitespace query: git count matches', r2.git.length === GROUPS.git.length);
  check('whitespace query: nonGit count matches', r2.nonGit.length === GROUPS.nonGit.length);

  // Git label match
  const r3 = filterGroups(GROUPS, 'muxy');
  check('matches git label: 1 git result', r3.git.length === 1, `got ${r3.git.length}`);
  check('matches git label: correct item', r3.git[0] && r3.git[0].label === 'muxy-extensions');
  check('matches git label: nonGit empty', r3.nonGit.length === 0);

  // Git displayPath match
  const r4 = filterGroups(GROUPS, 'Repos/ai-history');
  check('matches git displayPath: 1 git result', r4.git.length === 1, `got ${r4.git.length}`);
  check('matches git displayPath: correct item', r4.git[0] && r4.git[0].label === 'ai-history');

  // Git toplevel match
  const r5 = filterGroups(GROUPS, 'muxy-extensions');
  check('matches git toplevel: 1 git result', r5.git.length === 1);

  // Case-insensitive
  const r6a = filterGroups(GROUPS, 'MUXY');
  check('case-insensitive upper: 1 git result', r6a.git.length === 1, `got ${r6a.git.length}`);
  const r6b = filterGroups(GROUPS, 'MuXy-ExTenSions');
  check('case-insensitive mixed: 1 git result', r6b.git.length === 1, `got ${r6b.git.length}`);

  // Non-git label match (label is the full path)
  const r7 = filterGroups(GROUPS, 'scratch');
  check('matches nonGit label: 2 nonGit results', r7.nonGit.length === 2, `got ${r7.nonGit.length}`);
  check('matches nonGit label: 0 git results', r7.git.length === 0);

  // Non-git displayPath match
  const r8 = filterGroups(GROUPS, 'tmp');
  check('matches nonGit displayPath: 1 nonGit result', r8.nonGit.length === 1, `got ${r8.nonGit.length}`);
  check('matches nonGit displayPath: /tmp/scratch',
    r8.nonGit[0] && r8.nonGit[0].displayPath === '/tmp/scratch');

  // No matches
  const r9 = filterGroups(GROUPS, 'zzz-nonexistent-xyz');
  check('no matches: empty git', r9.git.length === 0);
  check('no matches: empty nonGit', r9.nonGit.length === 0);

  // Returns NEW arrays (not references)
  const r10 = filterGroups(GROUPS, '');
  check('returns new git array (not ref)', r10.git !== GROUPS.git);
  check('returns new nonGit array (not ref)', r10.nonGit !== GROUPS.nonGit);

  // null / undefined inputs don't crash
  const r11 = filterGroups(null, 'foo');
  check('null groups: empty result', r11.git.length === 0 && r11.nonGit.length === 0);
  const r12 = filterGroups(undefined, 'foo');
  check('undefined groups: empty result', r12.git.length === 0 && r12.nonGit.length === 0);

  // null query
  const r13 = filterGroups(GROUPS, null);
  check('null query: returns all items',
    r13.git.length === GROUPS.git.length && r13.nonGit.length === GROUPS.nonGit.length);
}

// ---- 2. getPickerLabel ------------------------------------------------------

console.log('\n2. getPickerLabel');
{
  // Empty / null / undefined filter
  check('empty string filter → "All projects"', getPickerLabel('', GROUPS, HOME) === 'All projects');
  check('null filter → "All projects"', getPickerLabel(null, GROUPS, HOME) === 'All projects');
  check('undefined filter → "All projects"', getPickerLabel(undefined, GROUPS, HOME) === 'All projects');

  // Git match by toplevel
  const l1 = getPickerLabel('/Users/x/Repos/muxy-extensions', GROUPS, HOME);
  check('git match by toplevel → "muxy-extensions"', l1 === 'muxy-extensions', `got "${l1}"`);

  // Git match by project (for git, project === toplevel, so same result)
  const l2 = getPickerLabel('/Users/x/Repos/ai-history', GROUPS, HOME);
  check('git match by project → "ai-history"', l2 === 'ai-history', `got "${l2}"`);

  // Non-git match by project (under home → abbreviated with `~`)
  const l3 = getPickerLabel('/Users/x/scratch', GROUPS, '/Users/x');
  check('nonGit under home → abbreviated with ~', l3 === '~/scratch', `got "${l3}"`);

  // Non-git match by displayPath (under home → abbreviated with `~`)
  const l3b = getPickerLabel('/Users/x/scratch', GROUPS, '/Users/x');
  // Same as above; we're testing the same code path
  check('nonGit match by displayPath → abbreviated with ~', l3b === '~/scratch', `got "${l3b}"`);

  // Non-git at /tmp/scratch (not under home) → unchanged
  const l4 = getPickerLabel('/tmp/scratch', GROUPS, '/Users/x');
  check('nonGit NOT under home → unchanged', l4 === '/tmp/scratch', `got "${l4}"`);

  // Stale filter (not in any group)
  const l5 = getPickerLabel('/nonexistent/path/never', GROUPS, HOME);
  check('stale filter → "All projects"', l5 === 'All projects', `got "${l5}"`);

  // null groups with non-empty filter
  const l6 = getPickerLabel('/foo', null, HOME);
  check('null groups → "All projects"', l6 === 'All projects');

  // Empty groups with non-empty filter
  const l7 = getPickerLabel('/foo', { git: [], nonGit: [] }, HOME);
  check('empty groups → "All projects"', l7 === 'All projects');
}

// ---- 3. buildPickerItems ----------------------------------------------------

console.log('\n3. buildPickerItems');
{
  // Both groups non-empty → all + 2 headers + N+M items
  const items1 = buildPickerItems(GROUPS, '');
  check('both groups: first item is "all"',
    items1[0].kind === 'all' && items1[0].value === '' && items1[0].active === true);
  check('both groups: second is project-header',
    items1[1].kind === 'project-header');
  check('both groups: 2 git projects',
    items1.filter((i) => i.kind === 'project').length === 2);
  check('both groups: 2 non-git paths',
    items1.filter((i) => i.kind === 'path').length === 2);
  check('both groups: total length 7 (1 all + 1 hdr + 2 proj + 1 hdr + 2 path)',
    items1.length === 7, `got ${items1.length}`);

  // Empty groups → returns just [all]
  const items2 = buildPickerItems({ git: [], nonGit: [] }, '');
  check('empty groups: length 1', items2.length === 1, `got ${items2.length}`);
  check('empty groups: only item is "all"',
    items2[0].kind === 'all' && items2[0].active === true);
  const items2b = buildPickerItems(null, '');
  check('null groups: returns just [all]', items2b.length === 1 && items2b[0].kind === 'all');
  const items2c = buildPickerItems(undefined, '');
  check('undefined groups: returns just [all]', items2c.length === 1 && items2c[0].kind === 'all');

  // Only git group
  const items3 = buildPickerItems({ git: GROUPS.git, nonGit: [] }, '');
  check('only git: no path-header', !items3.some((i) => i.kind === 'path-header'));
  check('only git: has project-header', items3.some((i) => i.kind === 'project-header'));
  check('only git: 2 project items', items3.filter((i) => i.kind === 'project').length === 2);

  // Only non-git group
  const items4 = buildPickerItems({ git: [], nonGit: GROUPS.nonGit }, '');
  check('only nonGit: no project-header', !items4.some((i) => i.kind === 'project-header'));
  check('only nonGit: has path-header', items4.some((i) => i.kind === 'path-header'));
  check('only nonGit: 2 path items', items4.filter((i) => i.kind === 'path').length === 2);

  // Active flag: filter empty → "all" is active
  const items5 = buildPickerItems(GROUPS, '');
  const active5 = items5.filter((i) => i.active === true);
  check('empty filter: "all" is active', active5.length === 1 && active5[0].kind === 'all');

  // Active flag: git filter matches toplevel
  const items6 = buildPickerItems(GROUPS, '/Users/x/Repos/muxy-extensions');
  const active6 = items6.filter((i) => i.active === true);
  check('git filter by toplevel: exactly 1 active', active6.length === 1, `got ${active6.length}`);
  check('git filter by toplevel: active item is the git project',
    active6[0] && active6[0].kind === 'project' && active6[0].value === '/Users/x/Repos/muxy-extensions');
  check('git filter: "all" is not active', !items6[0].active);

  // Active flag: non-git filter matches project
  const items7 = buildPickerItems(GROUPS, '/tmp/scratch');
  const active7 = items7.filter((i) => i.active === true);
  check('nonGit filter by project: exactly 1 active', active7.length === 1, `got ${active7.length}`);
  check('nonGit filter: active item is the path',
    active7[0] && active7[0].kind === 'path' && active7[0].value === '/tmp/scratch');

  // Headers show counts
  const items8 = buildPickerItems(GROUPS, '');
  const projHdr = items8.find((i) => i.kind === 'project-header');
  const pathHdr = items8.find((i) => i.kind === 'path-header');
  check('project-header label = "PROJECTS (2)"', projHdr && projHdr.label === 'PROJECTS (2)',
    `got "${projHdr && projHdr.label}"`);
  check('path-header label = "PATHS (2)"', pathHdr && pathHdr.label === 'PATHS (2)',
    `got "${pathHdr && pathHdr.label}"`);

  // Order: all → projects header → projects → paths header → paths
  const items9 = buildPickerItems(GROUPS, '');
  const order = items9.map((i) => i.kind);
  check('order: all → project-header → project → project → path-header → path → path',
    JSON.stringify(order) === JSON.stringify(['all', 'project-header', 'project', 'project', 'path-header', 'path', 'path']),
    `got ${JSON.stringify(order)}`);

  // Stale filter → no item is active
  const items10 = buildPickerItems(GROUPS, '/nonexistent/path/zzz');
  const active10 = items10.filter((i) => i.active === true);
  check('stale filter: no item is active', active10.length === 0, `got ${active10.length}`);

  // Git item exposes value === toplevel (so projectMatchesFilter works)
  const items11 = buildPickerItems(GROUPS, '');
  const projItem = items11.find((i) => i.kind === 'project');
  check('git item: value === toplevel', projItem && projItem.value === '/Users/x/Repos/muxy-extensions');
  check('git item: label === basename', projItem && projItem.label === 'muxy-extensions');
  check('git item: displayPath preserved', projItem && projItem.displayPath === '/Users/x/Repos/muxy-extensions');
  check('git item: count preserved', projItem && projItem.count === 5);

  // Non-git item exposes value === project
  const items12 = buildPickerItems(GROUPS, '');
  const pathItem = items12.find((i) => i.kind === 'path');
  check('path item: value === project', pathItem && pathItem.value === '/Users/x/scratch');
  check('path item: label === full path', pathItem && pathItem.label === '/Users/x/scratch');
}

// ---- 4. matchItem -----------------------------------------------------------

console.log('\n4. matchItem (keyboard navigation)');
{
  // Build a simple items array: [all, project-header, project, project, path-header, path, path]
  const items = buildPickerItems(GROUPS, '');

  // Down from -1 → first selectable (the "all" item at index 0)
  check('down from -1 → first selectable (index 0)',
    matchItem(items, 'down', -1) === 0, `got ${matchItem(items, 'down', -1)}`);

  // Up from -1 → last selectable (index 6, the last "path" item)
  check('up from -1 → last selectable (index 6)',
    matchItem(items, 'up', -1) === 6, `got ${matchItem(items, 'up', -1)}`);

  // Down from middle (the first "all" at 0) → next selectable is index 2 (first project)
  check('down from 0 → 2 (skipping project-header at 1)',
    matchItem(items, 'down', 0) === 2, `got ${matchItem(items, 'down', 0)}`);

  // Up from middle (index 2, first project) → 0 (the "all" item, skipping project-header)
  check('up from 2 → 0 (skipping project-header at 1)',
    matchItem(items, 'up', 2) === 0, `got ${matchItem(items, 'up', 2)}`);

  // Down from index 2 (first project) → 3 (next project)
  check('down from 2 → 3 (next project)',
    matchItem(items, 'down', 2) === 3, `got ${matchItem(items, 'down', 2)}`);

  // Up from index 3 (second project) → 2 (previous project)
  check('up from 3 → 2 (previous project)',
    matchItem(items, 'up', 3) === 2, `got ${matchItem(items, 'up', 3)}`);

  // Down from index 3 → 5 (skipping path-header at 4)
  check('down from 3 → 5 (skipping path-header at 4)',
    matchItem(items, 'down', 3) === 5, `got ${matchItem(items, 'down', 3)}`);

  // Up from index 5 (first path) → 3 (skipping path-header)
  check('up from 5 → 3 (skipping path-header at 4)',
    matchItem(items, 'up', 5) === 3, `got ${matchItem(items, 'up', 5)}`);

  // Down from last selectable (6) → wraps to 0
  check('down from 6 → 0 (wrap to first)',
    matchItem(items, 'down', 6) === 0, `got ${matchItem(items, 'down', 6)}`);

  // Up from first selectable (0) → wraps to 6
  check('up from 0 → 6 (wrap to last)',
    matchItem(items, 'up', 0) === 6, `got ${matchItem(items, 'up', 0)}`);

  // Down from a header (1) → next selectable is 2 (first project)
  check('down from header (1) → 2 (first project)',
    matchItem(items, 'down', 1) === 2, `got ${matchItem(items, 'down', 1)}`);

  // Up from a header (4) → previous selectable is 3 (last project)
  check('up from header (4) → 3 (last project)',
    matchItem(items, 'up', 4) === 3, `got ${matchItem(items, 'up', 4)}`);

  // Empty items → -1
  check('empty items: down → -1', matchItem([], 'down', -1) === -1);
  check('empty items: up → -1', matchItem([], 'up', -1) === -1);

  // No selectable items (only header)
  const noSel = [{ kind: 'project-header', label: 'X' }];
  check('only headers: down → -1', matchItem(noSel, 'down', -1) === -1);
  check('only headers: up → -1', matchItem(noSel, 'up', -1) === -1);

  // null / undefined items
  check('null items: down → -1', matchItem(null, 'down', -1) === -1);
  check('undefined items: up → -1', matchItem(undefined, 'up', -1) === -1);

  // Only the "all" item (no groups)
  const onlyAll = buildPickerItems({ git: [], nonGit: [] }, '');
  check('only all: down from 0 wraps to 0',
    matchItem(onlyAll, 'down', 0) === 0, `got ${matchItem(onlyAll, 'down', 0)}`);
  check('only all: up from 0 wraps to 0',
    matchItem(onlyAll, 'up', 0) === 0, `got ${matchItem(onlyAll, 'up', 0)}`);
}

// ---- 5. findActiveIndex -----------------------------------------------------

console.log('\n5. findActiveIndex');
{
  // Empty filter → "all" is active (index 0)
  const items1 = buildPickerItems(GROUPS, '');
  check('empty filter: returns 0 (the "all" item)',
    findActiveIndex(items1) === 0, `got ${findActiveIndex(items1)}`);

  // Git filter by toplevel → index of the matching project item
  const items2 = buildPickerItems(GROUPS, '/Users/x/Repos/muxy-extensions');
  const idx2 = findActiveIndex(items2);
  check('git filter: returns matching project index', idx2 === 2, `got ${idx2}`);
  if (idx2 >= 0) {
    check('git filter: matching item is "project"',
      items2[idx2].kind === 'project' && items2[idx2].value === '/Users/x/Repos/muxy-extensions');
  }

  // Git filter by project field
  const items3 = buildPickerItems(GROUPS, '/Users/x/Repos/ai-history');
  const idx3 = findActiveIndex(items3);
  check('git filter by project: returns matching project index', idx3 === 3, `got ${idx3}`);

  // Non-git filter → index of the matching path item
  const items4 = buildPickerItems(GROUPS, '/tmp/scratch');
  const idx4 = findActiveIndex(items4);
  check('nonGit filter: returns matching path index', idx4 === 6, `got ${idx4}`);
  if (idx4 >= 0) {
    check('nonGit filter: matching item is "path"',
      items4[idx4].kind === 'path' && items4[idx4].value === '/tmp/scratch');
  }

  // Non-git filter by displayPath
  const items5 = buildPickerItems(GROUPS, '/Users/x/scratch');
  const idx5 = findActiveIndex(items5);
  check('nonGit filter by displayPath: returns matching path index', idx5 === 5, `got ${idx5}`);

  // Stale filter → -1 (no item is active)
  const items6 = buildPickerItems(GROUPS, '/nonexistent/path/zzz');
  check('stale filter: returns -1', findActiveIndex(items6) === -1, `got ${findActiveIndex(items6)}`);

  // Empty groups → 0 (the "all" item is active)
  const items7 = buildPickerItems({ git: [], nonGit: [] }, '');
  check('empty groups: returns 0', findActiveIndex(items7) === 0);

  // null / undefined items
  check('null items: returns -1', findActiveIndex(null) === -1);
  check('undefined items: returns -1', findActiveIndex(undefined) === -1);

  // Empty array
  check('empty array: returns -1', findActiveIndex([]) === -1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
