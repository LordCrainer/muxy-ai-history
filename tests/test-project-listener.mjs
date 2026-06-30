// Test script: project-change listener pure logic
// Usage: node tests/test-project-listener.mjs
//
// Covers the 4 exports in src/panel/project-change-listener.js:
//   - PROJECT_CHANGE_CANDIDATES
//   - extractPathFromProjectEvent
//   - setupProjectChangeListener
//   - startPollingFallback
//
// All four are pure-ish: no DOM, no Muxy host, no `console`. The tests inject
// small muxy stubs (with a recording `events.subscribe` and a fake
// `git.repoInfo`) and mock state to drive the helpers.

import {
  PROJECT_CHANGE_CANDIDATES,
  extractPathFromProjectEvent,
  setupProjectChangeListener,
  startPollingFallback
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


// ---- 4. startPollingFallback -----------------------------------------------

// Mock factory for startPollingFallback tests. The mock `setIntervalFn`
// captures the callback so the test can drive ticks manually without real
// timers. `clearInterval` is monkey-patched on globalThis to track cleanup.
// Note: tests that need the polling tick to run MUST pass setIntervalFn:
// mocks.setIntervalFn to startPollingFallback, otherwise the helper uses the
// real globalThis.setInterval and the captured callback never runs.
function createPollingMocks({ initialRoot = null, repoInfoThrows = false } = {}) {
  let currentRoot = initialRoot;
  const repoInfo = () => {
    if (repoInfoThrows) throw new Error('repoInfo failed');
    return currentRoot == null ? null : { root: currentRoot };
  };
  const muxy = { git: { repoInfo } };
  let captured = null;
  const setIntervalFn = (cb, ms) => {
    captured = { cb, ms };
    return 'interval-handle';
  };
  const clearedHandles = [];
  globalThis.clearInterval = (handle) => clearedHandles.push(handle);
  const state = { projectFilter: '' };
  const calls = [];
  const onFilterChange = (newPath) => calls.push(newPath);
  const tick = (newRoot) => {
    if (newRoot !== undefined) currentRoot = newRoot;
    if (captured && captured.cb) captured.cb();
  };
  return { muxy, state, onFilterChange, calls, setIntervalFn, tick, clearedHandles };
}

console.log('\n4. startPollingFallback');
{
  // 4.1 — muxy.git undefined → { active: false }
  {
    const mocks = createPollingMocks();
    const result = startPollingFallback({
      muxy: {},
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    check('muxy.git undefined: returns { active: false }', result.active === false);
  }

  // 4.2 — muxy.git.repoInfo undefined → { active: false }
  {
    const mocks = createPollingMocks();
    const result = startPollingFallback({
      muxy: { git: {} },
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    check('muxy.git.repoInfo undefined: returns { active: false }', result.active === false);
  }

  // 4.3 — muxy.git.repoInfo not a function → { active: false } (defensive)
  {
    const mocks = createPollingMocks();
    const result = startPollingFallback({
      muxy: { git: { repoInfo: 'not-a-fn' } },
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    check('muxy.git.repoInfo not a function: returns { active: false } (defensive)',
      result.active === false);
  }

  // 4.4 — Happy path: first tick captures baseline, no fire
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    const result = startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    check('happy: returns { active: true, stop: fn }',
      result.active === true && typeof result.stop === 'function');
    mocks.tick();
    check('happy: first tick does NOT call onFilterChange (baseline capture)',
      mocks.calls.length === 0, `got ${mocks.calls.length} call(s)`);
  }

  // 4.5 — Same root on second tick → no fire
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();
    mocks.tick();
    check('same root: second tick does NOT call onFilterChange',
      mocks.calls.length === 0, `got ${mocks.calls.length} call(s)`);
  }

  // 4.6 — Root changes → onFilterChange called with new root
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();      // baseline: /a
    mocks.tick('/b');  // change to /b
    check('root change: onFilterChange called once with new root',
      mocks.calls.length === 1 && mocks.calls[0] === '/b',
      `got ${JSON.stringify(mocks.calls)}`);
  }

  // 4.7 — Root changes to state.projectFilter → no fire (dedup)
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    mocks.state.projectFilter = '/b';
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();      // baseline: /a
    mocks.tick('/b');  // matches state.projectFilter
    check('change to projectFilter: onFilterChange NOT called (dedup)',
      mocks.calls.length === 0, `got ${JSON.stringify(mocks.calls)}`);
  }

  // 4.8 — User manually changes projectFilter, root stays → no thrash
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();
    mocks.state.projectFilter = '/a';  // user picks /a manually
    mocks.tick();
    mocks.tick();
    check('manual pick + same root: no thrash, onFilterChange NOT called',
      mocks.calls.length === 0, `got ${mocks.calls.length} call(s) (expected 0)`);
  }

  // 4.9 — repoInfo() throws → silent, polling continues
  {
    const mocks = createPollingMocks();
    mocks.muxy.git.repoInfo = () => { throw new Error('repoInfo failed'); };
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    let threw = false;
    try { mocks.tick(); } catch { threw = true; }
    check('repoInfo throws: tick is silent (no crash)',
      !threw, 'tick should swallow the throw');
    check('repoInfo throws: onFilterChange NOT called',
      mocks.calls.length === 0);
  }

  // 4.10 — repoInfo() returns {} → silent
  {
    const mocks = createPollingMocks();
    mocks.muxy.git.repoInfo = () => ({});
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    let threw = false;
    try { mocks.tick(); } catch { threw = true; }
    check('repoInfo returns {}: silent (no root field, no crash)',
      !threw && mocks.calls.length === 0);
  }

  // 4.11 — repoInfo() returns { root: null } → silent
  {
    const mocks = createPollingMocks();
    mocks.muxy.git.repoInfo = () => ({ root: null });
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    let threw = false;
    try { mocks.tick(); } catch { threw = true; }
    check('repoInfo returns { root: null }: silent (null treated as missing)',
      !threw && mocks.calls.length === 0);
  }

  // 4.12 — repoInfo() returns { root: '' } → silent
  {
    const mocks = createPollingMocks();
    mocks.muxy.git.repoInfo = () => ({ root: '' });
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    let threw = false;
    try { mocks.tick(); } catch { threw = true; }
    check('repoInfo returns { root: "" }: silent (empty string treated as missing)',
      !threw && mocks.calls.length === 0);
  }

  // 4.13 — onFilterChange throws → silent, polling continues
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    let throwOnce = true;
    const throwingOnFilterChange = (newPath) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('render failed');
      }
      mocks.calls.push(newPath);
    };
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: throwingOnFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();      // baseline: /a (no fire)
    mocks.tick('/b');  // onFilterChange throws
    let threw = false;
    try { mocks.tick('/c'); } catch { threw = true; }
    check('onFilterChange throws: tick is silent (no crash)',
      !threw);
    check('onFilterChange throws: subsequent tick with NEW root DOES call onFilterChange',
      mocks.calls.length === 1 && mocks.calls[0] === '/c',
      `got ${JSON.stringify(mocks.calls)}`);
  }

  // 4.14 — state.currentDetail set + root change → onFilterChange called
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    mocks.state.currentDetail = { some: 'thing' };
    startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    mocks.tick();
    mocks.tick('/b');
    check('currentDetail set + root change: onFilterChange called with new path',
      mocks.calls.length === 1 && mocks.calls[0] === '/b',
      `got ${JSON.stringify(mocks.calls)}`);
  }

  // 4.15 — default intervalMs is 3000
  {
    let capturedMs = null;
    const muxy = { git: { repoInfo: () => ({ root: '/a' }) } };
    const state = { projectFilter: '' };
    const onFilterChange = () => {};
    const recordingSetInterval = (cb, ms) => { capturedMs = ms; return 'h'; };
    startPollingFallback({ muxy, state, onFilterChange, setIntervalFn: recordingSetInterval });
    check('default intervalMs: 3000 passed to setIntervalFn',
      capturedMs === 3000, `got ${capturedMs}`);
  }

  // 4.16 — custom intervalMs
  {
    let customMs = null;
    const muxy = { git: { repoInfo: () => ({ root: '/a' }) } };
    const state = { projectFilter: '' };
    const onFilterChange = () => {};
    const recordingSetInterval2 = (cb, ms) => { customMs = ms; return 'h'; };
    startPollingFallback({
      muxy, state, onFilterChange,
      setIntervalFn: recordingSetInterval2,
      intervalMs: 500
    });
    check('custom intervalMs: passed through to setIntervalFn',
      customMs === 500, `got ${customMs}`);
  }

  // 4.17 — stop() calls clearInterval with the right handle
  {
    const mocks = createPollingMocks({ initialRoot: '/a' });
    const result = startPollingFallback({
      muxy: mocks.muxy,
      state: mocks.state,
      onFilterChange: mocks.onFilterChange,
      setIntervalFn: mocks.setIntervalFn
    });
    result.stop();
    check('stop(): clearInterval called with the interval handle',
      mocks.clearedHandles.length === 1 && mocks.clearedHandles[0] === 'interval-handle',
      `got ${mocks.clearedHandles.length} handle(s)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
