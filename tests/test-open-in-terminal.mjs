// Test script: openInTerminal flow with mocked Muxy API
// Usage: node tests/test-open-in-terminal.mjs
//
// Covers the 12 acceptance criteria (CA A-L) for openInTerminal.
// Uses the extracted module from src/panel/open-in-terminal.js so the
// Muxy API can be fully mocked. The test asserts on:
//   - which muxy.* API calls were made (and in what order)
//   - the toast / setStatus side effects
//   - the olog/owarn log output (for CA K)

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const extDir = resolve(__dirname, '..');

import { openInTerminal } from '../src/panel/open-in-terminal.js';
import {
  getVisibleConversations,
  applyCustomTitle,
  decodeClaudeProject,
  buildResumeCommand,
  findBestProjectForPath,
  findBestWorktreeForPath,
  isWorktreeActive,
  pathInside
} from '../src/panel/utils.js';

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

console.log('AI History - openInTerminal Tests (mocks)\n');

// ---- Mock factory ------------------------------------------------------------

function createMuxyMock() {
  const calls = [];
  const handlers = {};

  const make = (key) => async (...args) => {
    calls.push({ key, args });
    if (handlers[key]) return handlers[key](args, calls);
    return undefined;
  };

  const api = {
    calls,
    on: (key, fn) => { handlers[key] = fn; return api; },
    set: (key, value) => { handlers[key] = () => value; return api; }
  };
  api.tabs = { list: make('tabs.list'), switchTo: make('tabs.switchTo'), open: make('tabs.open') };
  api.projects = { list: make('projects.list'), switchTo: make('projects.switchTo') };
  api.worktrees = { list: make('worktrees.list'), switchTo: make('worktrees.switchTo') };
  api.git = {
    worktrees: make('git.worktrees'),
    worktree: { switchTo: make('git.worktree.switchTo') },
    repoInfo: make('git.repoInfo')
  };
  return api;
}

// ---- Test setup helper --------------------------------------------------------

function setupDeps({ muxy, conv, customTitles = {} } = {}) {
  const toasts = [];
  const statuses = [];
  const logCalls = [];

  const state = {
    all: [conv],
    provider: 'all',
    projectFilter: '',
    search: '',
    customTitles
  };

  const deps = {
    muxy,
    toast: (opts) => toasts.push(opts),
    setStatus: (text, kind) => statuses.push({ text, kind }),
    state,
    log: {
      olog: (step, msg, extra) => logCalls.push({ level: 'log', step, msg, extra }),
      owarn: (step, msg, extra) => logCalls.push({ level: 'warn', step, msg, extra })
    },
    getVisibleConversations,
    applyCustomTitle,
    decodeClaudeProject,
    buildResumeCommand,
    findBestProjectForPath,
    findBestWorktreeForPath,
    isWorktreeActive,
    pathInside
  };

  return { deps, toasts, statuses, logCalls };
}

function makeClaudeConv(id, projectDir) {
  // /Users/x/Repos/myrepo → "-Users-x-Repos-myrepo"
  const encoded = '-' + projectDir.slice(1).replace(/\//g, '-');
  return {
    provider: 'claude',
    id,
    project: encoded,
    title: 'Test conv',
    preview: '',
    lastTimestamp: new Date().toISOString()
  };
}

function makeOpencodeConv(id, projectDir) {
  return {
    provider: 'opencode',
    id,
    project: projectDir, // absolute path → decodeClaudeProject returns as-is
    title: 'Test conv',
    preview: '',
    lastTimestamp: new Date().toISOString()
  };
}

const callsFor = (muxy, predicate) => muxy.calls.filter((c) => predicate(c));

// ---- Test 1: manifest permissions (CA N smoke) -------------------------------

console.log('1. Manifest permissions (CA N)');
{
  const pkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));
  const perms = pkg.muxy.permissions;
  check('manifest includes tabs:read', perms.includes('tabs:read'));
  check('manifest includes projects:read', perms.includes('projects:read'));
  check('manifest still includes tabs:write', perms.includes('tabs:write'));
  check('manifest still includes projects:write', perms.includes('projects:write'));
}

// ---- Test 2: buildResumeCommand + shell escape (CA L) -------------------------

console.log('\n2. Resume command (CA L)');
{
  check('claude: "claude --resume <id>"', buildResumeCommand('claude', 'ses_abc') === 'claude --resume ses_abc');
  check('opencode: "opencode -s <id>"', buildResumeCommand('opencode', 'ses_xyz') === 'opencode -s ses_xyz');
  check('unknown provider returns null', buildResumeCommand('foo', 'x') === null);
  // Shell escape of safeDir (the part wrapped in cd "...")
  // The escape logic: \\ → \\\\, " → \", $ → \$, ` → \`
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  check('shell-escape: backslash doubled', escape('/a\\b').includes('\\\\'));
  check('shell-escape: quote escaped', escape('/a"b').includes('\\"'));
  check('shell-escape: dollar escaped', escape('/a$b').includes('\\$'));
  check('shell-escape: backtick escaped', escape('/a`b').includes('\\`'));
}

// ---- Test 3: CA A - happy path composite (project + worktree + new tab) -------

console.log('\n3. CA A: happy path composite (project + worktree + new tab)');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const OTHER_REPO = '/Users/x/Repos/other-repo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }])
    .set('worktrees.list', [{ id: 'wt1', name: 'main', path: PROJECT, branch: 'main' }])
    .set('git.worktrees', [{ path: PROJECT, branch: 'main' }])
    .on('git.repoInfo', () => {
      const calls = muxy.calls.filter((c) => c.key === 'git.repoInfo');
      return { root: calls.length === 1 ? OTHER_REPO : PROJECT };
    });

  const { deps, toasts, statuses, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // projects.switchTo called
  check('CA A: projects.switchTo called', callsFor(muxy, (c) => c.key === 'projects.switchTo').length > 0);
  // worktrees.switchTo called with (name, projectId) positional
  const wtSwitch = callsFor(muxy, (c) => c.key === 'worktrees.switchTo');
  check('CA A: worktrees.switchTo called', wtSwitch.length > 0);
  if (wtSwitch.length > 0) {
    check('CA A: worktrees.switchTo is positional [id, projectId]',
      Array.isArray(wtSwitch[0].args) && wtSwitch[0].args[0] === 'main' && wtSwitch[0].args[1] === 'p1');
  }
  // tabs.open called with directory + command containing cd wrap
  const tabsOpen = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA A: tabs.open called', tabsOpen.length > 0);
  if (tabsOpen.length > 0) {
    const arg = tabsOpen[0].args[0];
    check('CA A: tabs.open has directory', arg && arg.directory === PROJECT);
    check('CA A: tabs.open has command with cd wrap', arg && arg.command && arg.command.includes(`cd "${PROJECT}" && opencode -s ses_abc`));
  }
  // Verify pass happened (repoInfo called >= 2 times)
  const repoInfoCalls = callsFor(muxy, (c) => c.key === 'git.repoInfo');
  check('CA A: git.repoInfo called >= 2 times (verify pass)', repoInfoCalls.length >= 2);
  // Log contains VERIFIED
  check('CA A: log contains "switch VERIFIED"',
    logCalls.some((l) => l.level === 'log' && l.msg && l.msg.includes('switch VERIFIED')));
  // Toast: "Switched worktree"
  check('CA A: toast "Switched worktree" emitted',
    toasts.some((t) => t.title === 'Switched worktree'));
}

// ---- Test 4: CA B - reuse existing tab ---------------------------------------

console.log('\n4. CA B: reuse existing tab');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [{ id: 'tab1', type: 'terminal', data: { directory: PROJECT } }])
    .set('projects.list', [])
    .set('worktrees.list', []);

  const { deps, toasts } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // tabs.switchTo called with 'tab1'
  const switchTo = callsFor(muxy, (c) => c.key === 'tabs.switchTo');
  check('CA B: tabs.switchTo called', switchTo.length > 0);
  if (switchTo.length > 0) {
    check('CA B: tabs.switchTo called with tab1 id', switchTo[0].args[0] === 'tab1');
  }
  // tabs.open NOT called
  check('CA B: tabs.open NOT called', callsFor(muxy, (c) => c.key === 'tabs.open').length === 0);
  // Toast: "Switched to terminal"
  check('CA B: toast "Switched to terminal" emitted',
    toasts.some((t) => t.title === 'Switched to terminal'));
}

// ---- Test 5: CA C - project NOT in Muxy --------------------------------------

console.log('\n5. CA C: project NOT in Muxy');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', []);  // empty list

  const { deps, toasts } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // projects.switchTo NOT called
  check('CA C: projects.switchTo NOT called',
    callsFor(muxy, (c) => c.key === 'projects.switchTo').length === 0);
  // tabs.open called with command containing cd wrap (no directory)
  const tabsOpen = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA C: tabs.open called', tabsOpen.length > 0);
  if (tabsOpen.length > 0) {
    const arg = tabsOpen[0].args[0];
    check('CA C: tabs.open has no directory', !arg || !arg.directory);
    check('CA C: tabs.open command has cd wrap', arg && arg.command && arg.command.includes(`cd "${PROJECT}"`));
  }
  // Toast: "New workspace (project not in Muxy)"
  check('CA C: toast "New workspace (project not in Muxy)"',
    toasts.some((t) => t.title === 'Opened in terminal' && t.body && t.body.includes('New workspace')));
}

// ---- Test 6: CA D - project in Muxy but not active ----------------------------

console.log('\n6. CA D: project in Muxy but not active');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }])
    .set('worktrees.list', []);  // no worktrees → no worktree step

  const { deps, toasts } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  const switchTo = callsFor(muxy, (c) => c.key === 'projects.switchTo');
  check('CA D: projects.switchTo called', switchTo.length > 0);
  if (switchTo.length > 0) {
    check('CA D: projects.switchTo called with p1', switchTo[0].args[0] === 'p1');
  }
  check('CA D: toast "Switched project → myrepo"',
    toasts.some((t) => t.title === 'Switched project' && t.body && t.body.includes('myrepo')));
}

// ---- Test 7: CA E - worktree match, already active ---------------------------

console.log('\n7. CA E: worktree match, already active');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: true }])
    .set('worktrees.list', [{ id: 'wt1', name: 'main', path: PROJECT, branch: 'main' }])
    .set('git.repoInfo', { root: PROJECT });  // active = same as worktree

  const { deps, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // worktrees.switchTo NOT called (worktree already active)
  check('CA E: worktrees.switchTo NOT called',
    callsFor(muxy, (c) => c.key === 'worktrees.switchTo').length === 0);
  // Log: wtAlreadyActive=true
  check('CA E: log "wtAlreadyActive=true" emitted',
    logCalls.some((l) => l.msg && l.msg.includes('wtAlreadyActive=true')));
  // tabs.open called with directory
  const tabsOpen = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA E: tabs.open called', tabsOpen.length > 0);
  if (tabsOpen.length > 0) {
    check('CA E: tabs.open has directory', tabsOpen[0].args[0] && tabsOpen[0].args[0].directory === PROJECT);
  }
}

// ---- Test 8: CA F - worktree match, not active (NUCLEO DEL BUG) --------------

console.log('\n8. CA F: worktree match, not active (NUCLEO DEL BUG)');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const OTHER_REPO = '/Users/x/Repos/other-repo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }])
    .set('worktrees.list', [{ id: 'wt1', name: 'main', path: PROJECT, branch: 'main' }])
    .on('git.repoInfo', () => {
      const calls = muxy.calls.filter((c) => c.key === 'git.repoInfo');
      return { root: calls.length === 1 ? OTHER_REPO : PROJECT };
    });

  const { deps, toasts, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // worktrees.switchTo called
  const wtSwitch = callsFor(muxy, (c) => c.key === 'worktrees.switchTo');
  check('CA F: worktrees.switchTo called', wtSwitch.length > 0);
  if (wtSwitch.length > 0) {
    check('CA F: worktrees.switchTo positional [main, p1]',
      Array.isArray(wtSwitch[0].args) && wtSwitch[0].args[0] === 'main' && wtSwitch[0].args[1] === 'p1');
  }
  // Verify pass: git.repoInfo called >= 2 times
  const repoInfoCalls = callsFor(muxy, (c) => c.key === 'git.repoInfo');
  check('CA F: git.repoInfo called >= 2 times (initial + verify)', repoInfoCalls.length >= 2);
  // Log contains VERIFIED
  check('CA F: log "switch VERIFIED" emitted',
    logCalls.some((l) => l.msg && l.msg.includes('switch VERIFIED')));
  // Toast: "Switched worktree"
  check('CA F: toast "Switched worktree" emitted',
    toasts.some((t) => t.title === 'Switched worktree'));
}

// ---- Test 9: CA G - no worktree match ----------------------------------------

console.log('\n9. CA G: no worktree match');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const SOMEWHERE = '/Users/x/Repos/somewhere-else';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }])
    .set('worktrees.list', [{ id: 'wt1', name: 'feature', path: SOMEWHERE, branch: 'feature' }]);

  const { deps, toasts } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // worktrees.switchTo NOT called (no match)
  check('CA G: worktrees.switchTo NOT called',
    callsFor(muxy, (c) => c.key === 'worktrees.switchTo').length === 0);
  // tabs.open called with directory (new workspace in conversation's dir)
  const tabsOpen = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA G: tabs.open called', tabsOpen.length > 0);
  if (tabsOpen.length > 0) {
    check('CA G: tabs.open has directory', tabsOpen[0].args[0] && tabsOpen[0].args[0].directory === PROJECT);
  }
  // Toast: "New workspace (no matching worktree)"
  check('CA G: toast "New workspace (no matching worktree)"',
    toasts.some((t) => t.body && t.body.includes('no matching worktree')));
}

// ---- Test 10: CA H - no worktree support -------------------------------------

console.log('\n10. CA H: no worktree support');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  // Build a muxy mock WITHOUT worktree APIs
  const muxy = createMuxyMock();
  muxy.worktrees = undefined;  // no app-level worktree API
  muxy.git.worktrees = undefined;  // no git-level worktree API
  muxy.git.worktree = undefined;  // no worktree.switchTo either
  muxy.git.repoInfo = undefined;  // no repoInfo either
  muxy.set('tabs.list', []);
  muxy.set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }]);

  const { deps, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // No worktree.list or worktrees.switchTo calls
  check('CA H: worktrees.list NOT called',
    callsFor(muxy, (c) => c.key === 'worktrees.list').length === 0);
  check('CA H: worktrees.switchTo NOT called',
    callsFor(muxy, (c) => c.key === 'worktrees.switchTo').length === 0);
  // Log: "no worktree listFn available"
  check('CA H: log "no worktree listFn available" emitted',
    logCalls.some((l) => l.msg && l.msg.includes('no worktree listFn available')));
  // tabs.open still called (fallback)
  check('CA H: tabs.open still called',
    callsFor(muxy, (c) => c.key === 'tabs.open').length > 0);
}

// ---- Test 11: CA I - no projectDir resolvable --------------------------------

console.log('\n11. CA I: no projectDir resolvable');
{
  // conv with empty project → decodeClaudeProject returns '' → projectDir = null
  const conv = {
    provider: 'opencode',
    id: 'ses_abc',
    project: '',
    title: 'Test conv',
    preview: '',
    lastTimestamp: new Date().toISOString()
  };

  const muxy = createMuxyMock().set('tabs.list', []);

  const { deps, toasts } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  // No project/worktree logic
  check('CA I: projects.list NOT called',
    callsFor(muxy, (c) => c.key === 'projects.list').length === 0);
  check('CA I: worktrees.list NOT called',
    callsFor(muxy, (c) => c.key === 'worktrees.list').length === 0);
  // tabs.open called with command only (no cd, no directory)
  const tabsOpen = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA I: tabs.open called', tabsOpen.length > 0);
  if (tabsOpen.length > 0) {
    const arg = tabsOpen[0].args[0];
    check('CA I: tabs.open has no directory', !arg || !arg.directory);
    check('CA I: tabs.open command is bare resumeCmd',
      arg && arg.command === 'opencode -s ses_abc');
  }
  // Toast: "Opened in terminal: opencode -s ses_abc"
  check('CA I: toast "Opened in terminal" emitted',
    toasts.some((t) => t.title === 'Opened in terminal' && t.body && t.body.includes('opencode -s')));
}

// ---- Test 12: CA J - tabs.open rejects directory -----------------------------

console.log('\n12. CA J: tabs.open rejects directory → fallback');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: true }])
    .set('worktrees.list', [{ path: PROJECT, branch: 'main', name: 'main' }])
    .set('git.repoInfo', { root: PROJECT })
    .on('tabs.open', (args) => {
      // First call WITH directory throws; subsequent calls succeed
      if (args[0] && args[0].directory) {
        throw new Error('directory must be an existing folder inside the worktree');
      }
      return { id: 'tab-1' };
    });

  const { deps, toasts, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  const tabsOpenCalls = callsFor(muxy, (c) => c.key === 'tabs.open');
  check('CA J: tabs.open called twice (with dir + fallback)', tabsOpenCalls.length === 2);
  if (tabsOpenCalls.length >= 2) {
    check('CA J: first call has directory',
      tabsOpenCalls[0].args[0] && tabsOpenCalls[0].args[0].directory === PROJECT);
    check('CA J: second call has NO directory',
      !tabsOpenCalls[1].args[0] || !tabsOpenCalls[1].args[0].directory);
  }
  // Log: "tabs.open(directory, command) failed"
  check('CA J: log warns about tabs.open(directory) failure',
    logCalls.some((l) => l.level === 'warn' && l.msg && l.msg.includes('tabs.open(directory')));
  // Toast: "Opened in terminal ... (worktree switch failed)" or similar
  check('CA J: toast indicates fallback',
    toasts.some((t) => t.title === 'Opened in terminal'));
}

// ---- Test 13: CA K - diagnostic logging at every step ------------------------

console.log('\n13. CA K: diagnostic logging at every step');
{
  const PROJECT = '/Users/x/Repos/myrepo';
  const conv = makeOpencodeConv('ses_abc', PROJECT);

  // Use the happy-path scenario so all steps fire
  const muxy = createMuxyMock()
    .set('tabs.list', [])
    .set('projects.list', [{ id: 'p1', name: 'myrepo', path: PROJECT, isActive: false }])
    .set('worktrees.list', [{ name: 'main', path: PROJECT, branch: 'main' }])
    .on('git.repoInfo', () => {
      const calls = muxy.calls.filter((c) => c.key === 'git.repoInfo');
      return { root: calls.length === 1 ? '/Users/x/Repos/other' : PROJECT };
    });

  const { deps, logCalls } = setupDeps({ muxy, conv });
  await openInTerminal(deps, 'opencode', 'ses_abc');

  const hasStep = (s) => logCalls.some((l) => l.step === s);
  check('CA K: step=0 logged', hasStep(0));
  check('CA K: step="pre" logged', hasStep('pre'));
  check('CA K: step=1 logged', hasStep(1));
  check('CA K: step=3 logged', hasStep(3));
  check('CA K: step=4 logged', hasStep(4));
  check('CA K: step=5 logged', hasStep(5));
  check('CA K: step=6 logged', hasStep(6));
  check('CA K: step=7 logged', hasStep(7));
  // Pre-check API availability messages
  check('CA K: pre-check logs muxy.tabs.open availability',
    logCalls.some((l) => l.step === 'pre' && l.msg && l.msg.includes('muxy.tabs.open=')));
  check('CA K: pre-check logs muxy.projects availability',
    logCalls.some((l) => l.step === 'pre' && l.msg && l.msg.includes('muxy.projects=')));
  check('CA K: pre-check logs muxy.worktrees availability',
    logCalls.some((l) => l.step === 'pre' && l.msg && l.msg.includes('muxy.worktrees=')));
  check('CA K: pre-check logs muxy.git.repoInfo availability',
    logCalls.some((l) => l.step === 'pre' && l.msg && l.msg.includes('muxy.git.repoInfo=')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
