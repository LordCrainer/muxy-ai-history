// Test script: project-change listener pure logic
// Usage: node tests/test-project-listener.mjs
//
// Covers the 3 exports in src/panel/project-change-listener.js:
//   - PROJECT_CHANGE_CANDIDATES
//   - extractPathFromProjectEvent
//   - setupProjectChangeListener
//
// All three are pure: no DOM, no Muxy host, no `console`. The tests inject a
// small muxy stub (with a recording `events.subscribe`) and a mock state to
// drive `setupProjectChangeListener`.

import {
  PROJECT_CHANGE_CANDIDATES,
  extractPathFromProjectEvent,
  setupProjectChangeListener
} from '../src/panel/project-change-listener.js';

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

console.log('AI History - Project Change Listener Tests\n');

// ---- Muxy host mock ---------------------------------------------------------
//
// `subscribe` records every (eventName, callback) pair so the test can:
//   1. assert that the helper subscribed to the expected events
//   2. invoke the recorded callback with a synthetic event payload
//      to drive the path-resolution logic.

function createMuxyHost({ throwingEvents = new Set() } = {}) {
  const subscribed = [];
  const events = {
    subscribe: (eventName, callback) => {
      subscribed.push({ eventName, callback });
      if (throwingEvents.has(eventName)) {
        throw new Error(`subscribe rejected for ${eventName}`);
      }
    }
  };
  return { muxy: { events }, subscribed };
}

// ---- 1. PROJECT_CHANGE_CANDIDATES -------------------------------------------

console.log('1. PROJECT_CHANGE_CANDIDATES');
{
  check('frozen array of 6 expected event names',
    Array.isArray(PROJECT_CHANGE_CANDIDATES)
      && Object.isFrozen(PROJECT_CHANGE_CANDIDATES)
      && PROJECT_CHANGE_CANDIDATES.length === 6
      && PROJECT_CHANGE_CANDIDATES[0] === 'project.changed'
      && PROJECT_CHANGE_CANDIDATES[5] === 'git.changed',
    `got ${JSON.stringify(PROJECT_CHANGE_CANDIDATES)}`);
}

// ---- 2. extractPathFromProjectEvent -----------------------------------------

console.log('\n2. extractPathFromProjectEvent');
{
  // Primary resolution: event.project.path
  check('reads event.project.path',
    extractPathFromProjectEvent({ project: { path: '/a/b' } }) === '/a/b');

  // Fallback 1: event.path (when project.path missing)
  check('falls back to event.path',
    extractPathFromProjectEvent({ path: '/c/d' }) === '/c/d');

  // Fallback 2: event.root (when project.path and path missing)
  check('falls back to event.root',
    extractPathFromProjectEvent({ root: '/e/f' }) === '/e/f');

  // Null / undefined / empty inputs
  check('null event → null', extractPathFromProjectEvent(null) === null);
  check('undefined event → null', extractPathFromProjectEvent(undefined) === null);
  check('object with no recognized path → null',
    extractPathFromProjectEvent({ unrelated: 'x' }) === null);

  // Empty strings treated as missing — falls through to next candidate or null
  check('empty project.path with valid event.root → event.root',
    extractPathFromProjectEvent({ project: { path: '' }, root: '/r' }) === '/r');
  check('all fields empty → null',
    extractPathFromProjectEvent({ project: { path: '' }, path: '', root: '' }) === null);
}

// ---- 3. setupProjectChangeListener ------------------------------------------

console.log('\n3. setupProjectChangeListener');
{
  // 3.1 — no muxy at all: returns empty result, no throws
  {
    const result = setupProjectChangeListener({
      muxy: undefined,
      state: { projectFilter: '' },
      onFilterChange: () => {}
    });
    check('muxy undefined → { subscribed: [], failed: [] }',
      Array.isArray(result.subscribed) && result.subscribed.length === 0
        && Array.isArray(result.failed) && result.failed.length === 0,
      `got ${JSON.stringify(result)}`);
  }

  // 3.2 — muxy.events missing
  {
    const result = setupProjectChangeListener({
      muxy: {},
      state: { projectFilter: '' },
      onFilterChange: () => {}
    });
    check('muxy.events undefined → { subscribed: [], failed: [] }',
      result.subscribed.length === 0 && result.failed.length === 0,
      `got ${JSON.stringify(result)}`);
  }

  // 3.3 — muxy.events.subscribe not a function
  {
    const result = setupProjectChangeListener({
      muxy: { events: { subscribe: 'not-a-fn' } },
      state: { projectFilter: '' },
      onFilterChange: () => {}
    });
    check('subscribe not a function → { subscribed: [], failed: [] }',
      result.subscribed.length === 0 && result.failed.length === 0,
      `got ${JSON.stringify(result)}`);
  }

  // 3.4 — happy path: subscribes to all 6 candidates
  {
    const { muxy, subscribed } = createMuxyHost();
    const result = setupProjectChangeListener({
      muxy,
      state: { projectFilter: '' },
      onFilterChange: () => {}
    });
    check('happy path: all 6 candidates subscribed, none failed',
      result.subscribed.length === 6
        && result.failed.length === 0
        && subscribed.length === 6
        && PROJECT_CHANGE_CANDIDATES.every((n) => result.subscribed.includes(n)),
      `subscribed=${result.subscribed.length} failed=${result.failed.length}`);
  }

  // 3.5 — some candidates throw: those are reported in `failed`
  {
    const { muxy, subscribed } = createMuxyHost({
      throwingEvents: new Set(['projects.active.changed', 'git.changed'])
    });
    const result = setupProjectChangeListener({
      muxy,
      state: { projectFilter: '' },
      onFilterChange: () => {}
    });
    check('partial-fail: 4 subscribed, 2 failed (the throwing ones)',
      result.subscribed.length === 4
        && result.failed.length === 2
        && result.failed.includes('projects.active.changed')
        && result.failed.includes('git.changed'),
      `subscribed=${result.subscribed.length} failed=${result.failed.length}`);
  }

  // 3.6 — callback skips when newPath is null (no recognized field in payload)
  {
    const { muxy, subscribed } = createMuxyHost();
    let onFilterChangeCalls = 0;
    setupProjectChangeListener({
      muxy,
      state: { projectFilter: '' },
      onFilterChange: () => { onFilterChangeCalls += 1; }
    });
    for (const { callback } of subscribed) {
      callback({ unrelated: 'x' });
    }
    check('null newPath: onFilterChange NOT called',
      onFilterChangeCalls === 0, `got ${onFilterChangeCalls} calls`);
  }

  // 3.7 — callback skips when newPath equals current filter
  {
    const { muxy, subscribed } = createMuxyHost();
    let onFilterChangeCalls = 0;
    setupProjectChangeListener({
      muxy,
      state: { projectFilter: '/already/active' },
      onFilterChange: () => { onFilterChangeCalls += 1; }
    });
    for (const { callback } of subscribed) {
      callback({ project: { path: '/already/active' } });
    }
    check('same path: onFilterChange NOT called',
      onFilterChangeCalls === 0, `got ${onFilterChangeCalls} calls`);
  }

  // 3.8 — callback fires when newPath differs from current filter
  {
    const { muxy, subscribed } = createMuxyHost();
    const onFilterChangeCalls = [];
    setupProjectChangeListener({
      muxy,
      state: { projectFilter: '/old' },
      onFilterChange: (p) => onFilterChangeCalls.push(p)
    });
    subscribed[0].callback({ project: { path: '/new' } });
    check('different path: onFilterChange called once with new path',
      onFilterChangeCalls.length === 1 && onFilterChangeCalls[0] === '/new',
      `got ${JSON.stringify(onFilterChangeCalls)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
