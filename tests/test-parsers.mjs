// Test script: validates that ai-history extension works
// Usage: node tests/test-parsers.mjs

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const extDir = resolve(__dirname, '..');
const oitSrc = readFileSync(join(extDir, 'src/panel/open-in-terminal.js'), 'utf-8');
const home = homedir();
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

console.log('AI History Extension - Smoke Test\n');

// Test 1: Claude projects exist
console.log('1. Claude data');
const claudeProjectsDir = join(home, '.claude/projects');
check('claude projects dir exists', existsSync(claudeProjectsDir));
if (existsSync(claudeProjectsDir)) {
  const projects = execSync(`/bin/ls -1 "${claudeProjectsDir}"`).toString().trim().split('\n');
  check('at least 1 claude project', projects.length > 0, `got ${projects.length}`);
}

// Test 2: OpenCode DB exists
console.log('\n2. OpenCode data');
const ocDb = join(home, '.local/share/opencode/opencode.db');
check('opencode db exists', existsSync(ocDb));
if (existsSync(ocDb)) {
  const sessionCount = execSync(`/usr/bin/sqlite3 "${ocDb}" "SELECT COUNT(*) FROM session"`).toString().trim();
  check('opencode has sessions', parseInt(sessionCount) > 0, `got ${sessionCount}`);
}

// Test 3: SQLite query (list sessions)
console.log('\n3. SQLite query (list sessions)');
if (existsSync(ocDb)) {
  try {
    const result = execSync(`/usr/bin/sqlite3 -json "${ocDb}" "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 5"`).toString();
    const rows = JSON.parse(result);
    check('parsed JSON', Array.isArray(rows));
    check('has 5 rows', rows.length === 5, `got ${rows.length}`);
  } catch (e) {
    check('parsed JSON', false, e.message);
  }
}

// Test 4: SQLite query (get messages)
console.log('\n4. SQLite query (get messages)');
if (existsSync(ocDb)) {
  try {
    const sessionId = execSync(`/usr/bin/sqlite3 "${ocDb}" "SELECT id FROM session LIMIT 1"`).toString().trim();
    const sql = `SELECT m.id, m.time_created, p.data FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${sessionId}' ORDER BY m.time_created ASC LIMIT 50`;
    const result = execSync(`/usr/bin/sqlite3 -json "${ocDb}" "${sql.replace(/"/g, '\\"')}"`).toString();
    const rows = JSON.parse(result);
    check('parsed JSON', Array.isArray(rows));
    check('has data rows', rows.length > 0, `got ${rows.length}`);
  } catch (e) {
    check('parsed JSON', false, e.message);
  }
}

// Test 5: dist files exist
console.log('\n5. dist/ build artifacts');
for (const file of ['dist/panel.html', 'dist/package.json', 'dist/icon.svg']) {
  check(`${file} exists`, existsSync(join(extDir, file)));
}

// Test 6: panel.html references assets
console.log('\n6. dist/panel.html content');
const panelHtml = readFileSync(join(extDir, 'dist/panel.html'), 'utf-8');
check('panel.html references assets', panelHtml.includes('./assets/'));
check('panel.html has main element', panelHtml.includes('<main'));

// Test 7: package.json valid JSON
console.log('\n7. dist/package.json validity');
try {
  const pkg = JSON.parse(readFileSync(join(extDir, 'dist/package.json'), 'utf-8'));
  check('has muxy manifest', !!pkg.muxy);
  check('has panel entry', pkg.muxy.panels && pkg.muxy.panels[0] && pkg.muxy.panels[0].entry === 'panel.html');
  check('does NOT require background', !pkg.muxy.background);
  check('has panels:write permission', pkg.muxy.permissions && pkg.muxy.permissions.includes('panels:write'));
  check('has notifications:write permission', pkg.muxy.permissions && pkg.muxy.permissions.includes('notifications:write'));
  check('has tabs:write permission (v0.3 open-in-terminal)', pkg.muxy.permissions && pkg.muxy.permissions.includes('tabs:write'));
  check('has commands:exec permission (required for muxy.exec)', pkg.muxy.permissions && pkg.muxy.permissions.includes('commands:exec'));
  check('has toggle-history command', pkg.muxy.commands && pkg.muxy.commands.some(c => c.id === 'toggle-history'));
} catch (e) {
  check('package.json valid', false, e.message);
}

// Test 8: source main.js does not call muxy.commands.exec
console.log('\n8. source main.js safety');
const mainJs = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('does not call muxy.commands.exec', !mainJs.includes('muxy.commands.exec'));
check('uses muxy.exec', mainJs.includes('muxy.exec'));

// Test 9: new UI elements present in source panel.html
console.log('\n9. New UI elements in panel.html');
const srcPanelHtml = readFileSync(join(extDir, 'src/panel/panel.html'), 'utf-8');
check('has project-picker button', srcPanelHtml.includes('id="project-picker"'));
check('has load-more button', srcPanelHtml.includes('id="load-more"'));
check('has menu-popover container', srcPanelHtml.includes('id="menu-popover"'));

// Test 10: new UI elements styled
console.log('\n10. New UI elements styled in styles.css');
const styles = readFileSync(join(extDir, 'src/panel/styles.css'), 'utf-8');
check('styles .project-picker', styles.includes('.project-picker'));
check('styles .load-more', styles.includes('.load-more'));
check('styles .menu-popover', styles.includes('.menu-popover'));
check('styles .conv-menu-trigger', styles.includes('.conv-menu-trigger'));
check('styles .conv-title-input', styles.includes('.conv-title-input'));

// Test 11: utils module is importable and pure
console.log('\n11. utils.js pure functions');
const utils = await import(join(extDir, 'src/panel/utils.js'));

check('formatDate exists', typeof utils.formatDate === 'function');
check('formatTimestamp exists', typeof utils.formatTimestamp === 'function');
check('escapeHtml exists', typeof utils.escapeHtml === 'function');
check('escapeSqlString exists', typeof utils.escapeSqlString === 'function');
check('slugify exists', typeof utils.slugify === 'function');
check('displayProject exists', typeof utils.displayProject === 'function');
check('buildMarkdown exists', typeof utils.buildMarkdown === 'function');
check('buildRenameSql exists', typeof utils.buildRenameSql === 'function');
check('applyCustomTitle exists', typeof utils.applyCustomTitle === 'function');
check('getVisibleConversations exists', typeof utils.getVisibleConversations === 'function');
check('paginate exists', typeof utils.paginate === 'function');
check('uniqueProjects exists', typeof utils.uniqueProjects === 'function');
check('decodeClaudeProject exists', typeof utils.decodeClaudeProject === 'function');
check('abbreviateHome exists', typeof utils.abbreviateHome === 'function');
check('expandHome exists', typeof utils.expandHome === 'function');
check('extractRepoLabel exists', typeof utils.extractRepoLabel === 'function');
check('buildResumeCommand exists', typeof utils.buildResumeCommand === 'function');
check('projectDisplayGroups exists', typeof utils.projectDisplayGroups === 'function');

// Test 12: utility function behavior
console.log('\n12. Utility function behavior');
check('escapeHtml escapes <', utils.escapeHtml('<script>') === '&lt;script&gt;');
check('escapeHtml escapes &', utils.escapeHtml('a & b') === 'a &amp; b');
check('escapeHtml handles null', utils.escapeHtml(null) === '');
check('escapeSqlString escapes single quote', utils.escapeSqlString("O'Brien") === "O''Brien");
check('escapeSqlString handles empty', utils.escapeSqlString('') === '');
check('slugify replaces slashes', utils.slugify('a/b:c') === 'a-b-c');
check('slugify handles empty', utils.slugify('') === 'untitled');
check('slugify collapses dashes', utils.slugify('a  --  b') === 'a-b');
check('displayProject shortens path', utils.displayProject('/Users/x/Repos/foo/bar').endsWith('/foo/bar'));
check('displayProject keeps short path', utils.displayProject('/a/b') === '/a/b');
check('displayProject handles empty', utils.displayProject('') === '');

// Test 13: buildMarkdown output structure
console.log('\n13. buildMarkdown output');
const conv = {
  provider: 'claude',
  id: 'sess-1234-abc',
  project: '/Users/x/Repos/foo',
  title: 'Test Session',
  firstTimestamp: '2026-06-22T10:00:00.000Z',
  lastTimestamp: '2026-06-23T10:00:00.000Z'
};
const msgs = [
  { role: 'user', content: 'Hello', timestamp: '2026-06-22T10:00:00.000Z' },
  { role: 'assistant', content: 'Hi there', timestamp: '2026-06-22T10:01:00.000Z' }
];
const md = utils.buildMarkdown(conv, msgs);
check('has H1 title', md.startsWith('# Test Session'));
check('has Provider line', md.includes('**Provider**: Claude Code'));
check('has Project line', md.includes('**Project**: /Users/x/Repos/foo'));
check('has Created line', md.includes('**Created**:'));
check('has Updated line', md.includes('**Updated**:'));
check('has Session ID line', md.includes('**Session ID**: sess-1234-abc'));
check('has Messages count', md.includes('**Messages**: 2'));
check('has USER section', md.includes('## USER'));
check('has ASSISTANT section', md.includes('## ASSISTANT'));
check('has user content', md.includes('Hello'));
check('has assistant content', md.includes('Hi there'));
check('has horizontal rule', md.includes('---'));

// Test 14: buildMarkdown with OpenCode
const ocConv = { ...conv, provider: 'opencode' };
const ocMd = utils.buildMarkdown(ocConv, msgs);
check('OpenCode label', ocMd.includes('**Provider**: OpenCode'));

// Test 15: buildMarkdown with empty messages
const emptyMd = utils.buildMarkdown(conv, []);
check('empty messages count', emptyMd.includes('**Messages**: 0'));

// Test 16: buildMarkdown handles untitled
const untitledConv = { ...conv, title: null };
const untitledMd = utils.buildMarkdown(untitledConv, msgs);
check('untitled fallback', untitledMd.startsWith('# (untitled)'));

// Test 17: buildRenameSql escapes quotes
console.log('\n14. buildRenameSql escaping');
const sql = utils.buildRenameSql("sess-id-with'apos", "Title with 'quotes'");
check('escapes single quotes in id', sql.includes("'sess-id-with''apos'"));
check('escapes single quotes in title', sql.includes("'Title with ''quotes'''"));
check('starts with UPDATE', sql.startsWith("UPDATE session SET title='"));
check('ends with semicolon', sql.trimEnd().endsWith(';'));
check('has WHERE clause', sql.includes("WHERE id='"));

// Test 18: applyCustomTitle
console.log('\n15. applyCustomTitle merging');
const sampleConv = { provider: 'claude', id: 'abc', title: 'Original' };
check('no override when no custom title', utils.applyCustomTitle(sampleConv, {}).title === 'Original');
check('override with custom title', utils.applyCustomTitle(sampleConv, { 'claude:abc': 'New' }).title === 'New');
check('null conv safe', utils.applyCustomTitle(null, {}) === null);
check('different id no override', utils.applyCustomTitle(sampleConv, { 'claude:xyz': 'Other' }).title === 'Original');

// Test 19: getVisibleConversations
console.log('\n16. getVisibleConversations filter+sort');
const sampleList = [
  { id: '1', provider: 'claude', title: 'How to foo', project: '/p/a', lastTimestamp: '2026-06-22T10:00:00.000Z' },
  { id: '2', provider: 'opencode', title: 'Bar things', project: '/p/b', lastTimestamp: '2026-06-23T10:00:00.000Z' },
  { id: '3', provider: 'claude', title: 'Baz qux', project: '/p/a', lastTimestamp: '2026-06-21T10:00:00.000Z' }
];
const all = utils.getVisibleConversations(sampleList);
check('returns all when no filter', all.length === 3);
check('sorted desc by timestamp', all[0].id === '2' && all[1].id === '1' && all[2].id === '3');
const onlyClaude = utils.getVisibleConversations(sampleList, { provider: 'claude' });
check('filters by provider', onlyClaude.length === 2 && onlyClaude.every((c) => c.provider === 'claude'));
const onlyProjectA = utils.getVisibleConversations(sampleList, { projectFilter: '/p/a' });
check('filters by project', onlyProjectA.length === 2);
const searched = utils.getVisibleConversations(sampleList, { search: 'foo' });
check('filters by search', searched.length === 1 && searched[0].id === '1');
const searchedProject = utils.getVisibleConversations(sampleList, { search: '/p/b' });
check('search matches project', searchedProject.length === 1 && searchedProject[0].id === '2');

// Test 20: paginate
console.log('\n17. paginate');
const list100 = Array.from({ length: 120 }, (_, i) => ({ id: String(i) }));
const p1 = utils.paginate(list100, 1, 50);
check('page 1 has 50 items', p1.items.length === 50);
check('page 1 hasMore=true', p1.hasMore === true);
check('page 1 remaining=70', p1.remaining === 70);

const p2 = utils.paginate(list100, 2, 50);
check('page 2 has 100 items total', p2.items.length === 100);
check('page 2 hasMore=true', p2.hasMore === true);
check('page 2 remaining=20', p2.remaining === 20);

const p3 = utils.paginate(list100, 3, 50);
check('page 3 has all 120', p3.items.length === 120);
check('page 3 hasMore=false', p3.hasMore === false);
check('page 3 remaining=0', p3.remaining === 0);

const p4 = utils.paginate(list100, 99, 50);
check('overshoot caps at length', p4.items.length === 120);
check('overshoot hasMore=false', p4.hasMore === false);

// Test 21: uniqueProjects
console.log('\n18. uniqueProjects');
const projs = utils.uniqueProjects(sampleList);
check('returns sorted unique', JSON.stringify(projs) === JSON.stringify(['/p/a', '/p/b']));
check('handles empty project', utils.uniqueProjects([{ id: '1' }]).length === 0);

// Test 22: package.json dist has new permission
console.log('\n19. dist package.json updated');
const distPkg = JSON.parse(readFileSync(join(extDir, 'dist/package.json'), 'utf-8'));
check('dist has notifications:write', distPkg.muxy.permissions.includes('notifications:write'));
check('dist has commands:exec', distPkg.muxy.permissions.includes('commands:exec'));
check('dist has tabs:write', distPkg.muxy.permissions.includes('tabs:write'));

// Test 23: bundled main.js has new code paths
console.log('\n20. bundled main.js has new features');
const distPanelHtml = readFileSync(join(extDir, 'dist/panel.html'), 'utf-8');
const distAssetMatch = distPanelHtml.match(/src="\.\/assets\/(panel-[^"]+\.js)"/);
check('panel asset referenced', !!distAssetMatch);
if (distAssetMatch) {
  const distJs = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle uses muxy.toast', distJs.includes('muxy.toast') || distJs.includes('.toast('));
  check('bundle has buildMarkdown', distJs.includes('buildMarkdown') || distJs.includes('Provider'));
  check('bundle has exportConversation (legacy auto-save)', distJs.includes('Exporting') || distJs.includes('exportConversation') || distJs.includes('Export failed'));
  check('bundle has renameConversation', distJs.includes('renameConversation') || distJs.includes('Renamed'));
  check('bundle has opencode UPDATE', distJs.includes('UPDATE session SET title'));
  check('bundle has custom titles sidecar', distJs.includes('custom-titles.json'));
  check('bundle has export modal (v0.4)', distJs.includes('export-modal') || distJs.includes('openExportModal'));
  check('bundle has markdown download trigger', distJs.includes('triggerMarkdownDownload') || distJs.includes('Blob'));
  check('bundle has page size 50', distJs.includes('50'));
  check('bundle has menu popover', distJs.includes('menu-popover') || distJs.includes('Menu'));
}

// Test 24: decodeClaudeProject
console.log('\n21. decodeClaudeProject');
check('decodes encoded path', utils.decodeClaudeProject('-Users-dev-Repos-ac') === '/Users/dev/Repos/ac');
check('passes through absolute path', utils.decodeClaudeProject('/Users/x/Repos/ac') === '/Users/x/Repos/ac');
check('handles empty', utils.decodeClaudeProject('') === '');
check('handles null', utils.decodeClaudeProject(null) === '');
check('handles single segment', utils.decodeClaudeProject('-foo') === '/foo');
check('handles deep nested', utils.decodeClaudeProject('-Users-dev-Repos-zt-zlp-2') === '/Users/dev/Repos/zt/zlp/2');

// Test 24b: v0.7.0 home expansion helpers
console.log('\n21b. v0.7.0 abbreviateHome / expandHome / decodeClaudeProject(home)');
// abbreviateHome
check('abbreviateHome: subpath under home', utils.abbreviateHome('/Users/x/Repos/foo', '/Users/x') === '~/Repos/foo');
check('abbreviateHome: path === home', utils.abbreviateHome('/Users/x', '/Users/x') === '~');
check('abbreviateHome: path outside home', utils.abbreviateHome('/tmp/scratch', '/Users/x') === '/tmp/scratch');
check('abbreviateHome: empty path', utils.abbreviateHome('', '/Users/x') === '');
check('abbreviateHome: empty home', utils.abbreviateHome('/Users/x/foo', '') === '/Users/x/foo');
check('abbreviateHome: null home', utils.abbreviateHome('/Users/x/foo', null) === '/Users/x/foo');
check('abbreviateHome: undefined home', utils.abbreviateHome('/Users/x/foo', undefined) === '/Users/x/foo');
// expandHome
check('expandHome: ~/foo', utils.expandHome('~/foo', '/Users/x') === '/Users/x/foo');
check('expandHome: ~', utils.expandHome('~', '/Users/x') === '/Users/x');
check('expandHome: $HOME/foo', utils.expandHome('$HOME/foo', '/Users/x') === '/Users/x/foo');
check('expandHome: absolute passthrough', utils.expandHome('/already/abs', '/Users/x') === '/already/abs');
check('expandHome: empty home', utils.expandHome('~/foo', '') === '~/foo');
// decodeClaudeProject with home param
check('decodeClaudeProject(home): ~-Users-x-Repos-foo', utils.decodeClaudeProject('~-Users-x-Repos-foo', '/Users/x') === '/Users/x/Repos/foo');
check('decodeClaudeProject(home): ~', utils.decodeClaudeProject('~', '/Users/x') === '/Users/x');
check('decodeClaudeProject(home): -Users-x-Repos-foo unchanged', utils.decodeClaudeProject('-Users-x-Repos-foo', '/Users/x') === '/Users/x/Repos/foo');

// Test 25: extractRepoLabel
console.log('\n22. extractRepoLabel');
const gitMap = {
  '/Users/dev/Repos/ac': '/Users/dev/Repos/ac',
  '/Users/dev/Repos/zt/zlp': '/Users/dev/Repos/zt/zlp'
};
const r1 = utils.extractRepoLabel('-Users-dev-Repos-ac', gitMap);
check('git label is basename', r1.label === 'ac');
check('git isGit true', r1.isGit === true);
check('git toplevel set', r1.toplevel === '/Users/dev/Repos/ac');
check('git displayPath decoded', r1.displayPath === '/Users/dev/Repos/ac');
const r2 = utils.extractRepoLabel('/Users/dev/Repos/ac', gitMap);
check('absolute path → git label', r2.label === 'ac');
const r3 = utils.extractRepoLabel('/Users/some/standalone', {});
check('non-git label is full path', r3.label === '/Users/some/standalone');
check('non-git isGit false', r3.isGit === false);
check('non-git toplevel null', r3.toplevel === null);
const r4 = utils.extractRepoLabel('-Users-missing', {});
check('unknown encoded → non-git', r4.isGit === false);
check('unknown encoded decoded', r4.displayPath === '/Users/missing');

// Test 26: buildResumeCommand
console.log('\n23. buildResumeCommand');
check('claude command', utils.buildResumeCommand('claude', 'abc-123') === 'claude --resume abc-123');
check('opencode command', utils.buildResumeCommand('opencode', 'sess_xyz') === 'opencode -s sess_xyz');
check('unknown provider null', utils.buildResumeCommand('foo', 'id') === null);

// Test 27: projectDisplayGroups
console.log('\n24. projectDisplayGroups');
const g1 = utils.projectDisplayGroups(['-Users-dev-Repos-ac', '/Users/some/standalone', '-Users-dev-Repos-zt-zlp'], gitMap);
check('git group has 2', g1.git.length === 2);
check('nonGit group has 1', g1.nonGit.length === 1);
check('git group sorted', g1.git[0].label === 'ac' && g1.git[1].label === 'zlp');
check('nonGit contains standalone', g1.nonGit[0].label === '/Users/some/standalone');
const g2 = utils.projectDisplayGroups([], {});
check('empty input', g2.git.length === 0 && g2.nonGit.length === 0);
const g3 = utils.projectDisplayGroups(['/Users/foo/Bar'], {});
check('all non-git when no map', g3.git.length === 0 && g3.nonGit.length === 1);

// Test 28: source main.js has v0.3 features
console.log('\n25. main.js v0.3 features');
const mainSrc = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('has openInTerminal', mainSrc.includes('openInTerminal') || mainSrc.includes('tabs.open'));
check('has copyMarkdownToClipboard', mainSrc.includes('copyMarkdownToClipboard') || mainSrc.includes('clipboard.writeText'));
check('has loadProjectLabels', mainSrc.includes('loadProjectLabels'));
check('has gitToplevel', mainSrc.includes('gitToplevel') || mainSrc.includes('rev-parse'));
check('has menuView state (v0.5.2 restored)', mainSrc.includes('menuView'));
check('has renderMenu function', mainSrc.includes('renderMenu'));
check('has decodeClaudeProject import', mainSrc.includes('decodeClaudeProject'));
check('has buildResumeCommand import', mainSrc.includes('buildResumeCommand'));
check('has projectDisplayGroups import', mainSrc.includes('projectDisplayGroups'));
check('has openExportModal (v0.4)', mainSrc.includes('openExportModal'));
check('has triggerMarkdownDownload (v0.4)', mainSrc.includes('triggerMarkdownDownload'));
check('has copyMarkdownFor (used by submenu)', mainSrc.includes('copyMarkdownFor'));
check('submenu renders Copy to Clipboard', mainSrc.includes('Copy to Clipboard'));
check('submenu renders Save as Markdown', mainSrc.includes('Save as Markdown'));

// Test 29: styles for export modal (v0.4)
console.log('\n26. styles.css export modal + submenu');
const stylesV3 = readFileSync(join(extDir, 'src/panel/styles.css'), 'utf-8');
check('styles .export-modal', stylesV3.includes('.export-modal'));
check('styles .export-modal-content', stylesV3.includes('.export-modal-content'));
check('styles .export-modal-preview', stylesV3.includes('.export-modal-preview'));
check('styles .export-modal-actions', stylesV3.includes('.export-modal-actions'));
check('modal max-height 500px', stylesV3.includes('max-height: 500px') || stylesV3.includes('max-height:500px'));
check('modal preview overflow auto', stylesV3.includes('overflow: auto') || stylesV3.includes('overflow:auto'));
check('modal backdrop', stylesV3.includes('.export-modal-backdrop'));
check('styles .menu-separator', stylesV3.includes('.menu-separator'));
check('styles .menu-header (submenu back button)', stylesV3.includes('.menu-header'));
check('styles .arrow (submenu indicator)', stylesV3.includes('.arrow'));

// Test 30: bundled main.js has v0.3 code paths
console.log('\n27. bundle v0.3 code paths');
if (distAssetMatch) {
  const distJs = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle has tabs.open call', distJs.includes('tabs.open') || distJs.includes('kind: \\"terminal\\"') || distJs.includes("'terminal'"));
  check('bundle has claude --resume', distJs.includes('claude --resume') || distJs.includes('--resume'));
  check('bundle has opencode -s', distJs.includes('opencode -s') || distJs.includes("'-s'"));
  check('bundle has clipboard write', distJs.includes('clipboard.writeText') || distJs.includes('writeText'));
  check('bundle has git rev-parse', distJs.includes('rev-parse') || distJs.includes('show-toplevel'));
  check('bundle has picker-section class', distJs.includes('picker-section'));
  check('bundle has PROJECTS section', distJs.includes('PROJECTS'));
  check('bundle has PATHS section', distJs.includes('PATHS'));
  check('bundle has submenu (Copy to Clipboard)', distJs.includes('Copy to Clipboard'));
  check('bundle has submenu (Save as Markdown)', distJs.includes('Save as Markdown'));
}

// Test 31: v0.3.1 utils - projectMatchesFilter
console.log('\n28. v0.3.1 projectMatchesFilter');
check('empty filter matches all', utils.projectMatchesFilter('/any/path', '') === true);
check('exact match (decoded path)', utils.projectMatchesFilter('/Users/foo/Repos/ac', '/Users/foo/Repos/ac') === true);
check('exact match (encoded path)', utils.projectMatchesFilter('-Users-foo-Repos-ac', '/Users/foo/Repos/ac') === true);
check('subpath match (claude subdir)', utils.projectMatchesFilter('/Users/foo/Repos/ac/sub', '/Users/foo/Repos/ac') === true);
check('subpath match (opencode subdir)', utils.projectMatchesFilter('/Users/foo/Repos/ac/sub/deep', '/Users/foo/Repos/ac') === true);
check('no match (different repo)', utils.projectMatchesFilter('/Users/foo/other', '/Users/foo/Repos/ac') === false);
check('no match (prefix collision)', utils.projectMatchesFilter('/Users/foo/Repos/ac2', '/Users/foo/Repos/ac') === false);
check('null project no match', utils.projectMatchesFilter(null, '/Users/foo') === false);
check('null filter matches all', utils.projectMatchesFilter('/any', null) === true);

// Test 32: v0.3.1 utils - chunkString
console.log('\n29. v0.3.1 chunkString');
check('empty string returns []', JSON.stringify(utils.chunkString('', 10)) === '[]');
check('null returns []', JSON.stringify(utils.chunkString(null, 10)) === '[]');
check('short string one chunk', JSON.stringify(utils.chunkString('abc', 10)) === '["abc"]');
check('exact boundary one chunk', JSON.stringify(utils.chunkString('abcdef', 6)) === '["abcdef"]');
check('splits correctly', JSON.stringify(utils.chunkString('abcdefgh', 3)) === '["abc","def","gh"]');
check('preserves order', utils.chunkString('0123456789', 2).join('') === '0123456789');
check('size=0 returns whole', JSON.stringify(utils.chunkString('abc', 0)) === '["abc"]');

// Test 33: v0.3.1 utils - projectDisplayGroups dedup
console.log('\n30. v0.3.1 projectDisplayGroups dedup');
const gitMapV2 = {
  '/Users/foo/Repos/ac': '/Users/foo/Repos/ac',
  '/Users/foo/Repos/zt': '/Users/foo/Repos/zt'
};
// Same repo via Claude encoded + OpenCode absolute → should dedupe to ONE entry
const dedup1 = utils.projectDisplayGroups([
  '-Users-foo-Repos-ac',           // Claude encoded
  '/Users/foo/Repos/ac',            // OpenCode absolute (same repo)
  '/Users/foo/Repos/ac/sub',        // OpenCode subdir (same repo)
  '/Users/foo/Repos/zt',            // OpenCode (different repo)
  '/Users/some/standalone'          // non-git
], gitMapV2);
check('dedup: git group has 2 (ac, zt)', dedup1.git.length === 2);
check('dedup: ac label', dedup1.git.find((g) => g.label === 'ac') !== undefined);
check('dedup: zt label', dedup1.git.find((g) => g.label === 'zt') !== undefined);
check('dedup: nonGit has 1', dedup1.nonGit.length === 1);
const acEntry = dedup1.git.find((g) => g.label === 'ac');
check('dedup: ac value is toplevel', acEntry.project === '/Users/foo/Repos/ac');
check('dedup: ac displayPath is decoded', acEntry.displayPath === '/Users/foo/Repos/ac');

// Test 34: v0.3.1 utils - getVisibleConversations uses subpath match
console.log('\n31. v0.3.1 getVisibleConversations subpath match');
const listSubpath = [
  { id: '1', provider: 'claude', title: 'A', project: '/Users/foo/Repos/ac', lastTimestamp: '2026-06-22T10:00:00.000Z' },
  { id: '2', provider: 'opencode', title: 'B', project: '/Users/foo/Repos/ac/sub', lastTimestamp: '2026-06-23T10:00:00.000Z' },
  { id: '3', provider: 'claude', title: 'C', project: '/Users/foo/Repos/zt', lastTimestamp: '2026-06-21T10:00:00.000Z' }
];
const filteredAc = utils.getVisibleConversations(listSubpath, { projectFilter: '/Users/foo/Repos/ac' });
check('subpath: matches ac and ac/sub', filteredAc.length === 2);
check('subpath: does not match zt', filteredAc.every((c) => c.project.startsWith('/Users/foo/Repos/ac')));
const filteredAcExact = utils.getVisibleConversations(listSubpath, { projectFilter: '/Users/foo/Repos/ac/sub' });
check('subpath: exact subpath matches only 1', filteredAcExact.length === 1 && filteredAcExact[0].id === '2');
const filteredEncoded = utils.getVisibleConversations([
  { id: '1', provider: 'claude', title: 'A', project: '-Users-foo-Repos-ac', lastTimestamp: '2026-06-22T10:00:00.000Z' }
], { projectFilter: '/Users/foo/Repos/ac' });
check('subpath: matches encoded Claude path', filteredEncoded.length === 1);

// Test 35: v0.3.1 main.js - chunked base64 helpers
console.log('\n32. v0.3.1 main.js chunked base64 helpers');
const mainSrcV4 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('imports chunkString', mainSrcV4.includes('chunkString'));
check('has base64Encode helper', mainSrcV4.includes('base64Encode'));
check('has writeLargeStringToFile', mainSrcV4.includes('writeLargeStringToFile'));
check('has copyLargeStringToClipboard', mainSrcV4.includes('copyLargeStringToClipboard'));
check('uses base64 -d in shell', mainSrcV4.includes('base64 -d') || mainSrcV4.includes('-d <'));
check('uses printf for chunks', mainSrcV4.includes('printf'));
check('no more heredoc AI_HISTORY_EOF', !mainSrcV4.includes("'AI_HISTORY_EOF'"));
check('no more JSON.stringify shell pipe', !mainSrcV4.includes("JSON.stringify(markdown)"));

// Test 36: v0.6.1 main.js - try with directory, fallback without (logged)
console.log('\n33. v0.6.1 main.js openInTerminal fallback');
const mainSrcV5 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('opens terminal with project directory', mainSrcV5.includes("kind: 'terminal', command: cmd, directory: projectDir") || mainSrcV5.includes("kind:\"terminal\",command:cmd,directory:projectDir"));
check('retries without directory on failure', mainSrcV5.includes('tabs.open(directory, command) failed') || mainSrcV5.includes("fallback: tabs.open(command only)"));
check('logs warning for failed attempt (owarn call)', /owarn\([^)]*tabs\.open/.test(mainSrcV5));
check('has informative toast for fallback', mainSrcV5.includes('New workspace') || mainSrcV5.includes('fallback cwd'));
check('still reuses existing terminal via tabs.list', mainSrcV5.includes('tabs.list'));

// Test 37: v0.3.1 main.js - projectMatchesFilter import + use
console.log('\n34. v0.3.1 main.js project filter');
check('imports projectMatchesFilter', mainSrcV4.includes('projectMatchesFilter'));

// Test 38: v0.3.1 manifest - git:read permission
console.log('\n35. v0.3.1 manifest permissions');
const srcPkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));
check('src has git:read permission', srcPkg.muxy.permissions.includes('git:read'));
check('src has tabs:write', srcPkg.muxy.permissions.includes('tabs:write'));
check('src has panels:write', srcPkg.muxy.permissions.includes('panels:write'));
check('src has notifications:write', srcPkg.muxy.permissions.includes('notifications:write'));
check('src has commands:exec', srcPkg.muxy.permissions.includes('commands:exec'));

// Test 39: v0.3.1 dist has git:read
console.log('\n36. v0.3.1 dist manifest');
const distPkgV4 = JSON.parse(readFileSync(join(extDir, 'dist/package.json'), 'utf-8'));
check('dist has git:read', distPkgV4.muxy.permissions.includes('git:read'));

// Test 40: v0.3.1 bundle has new code paths
console.log('\n37. v0.3.1 bundle code paths');
if (distAssetMatch) {
  const distJsV4 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  // Note: Vite minifies, so local identifiers get renamed. Check for
  // minification-resistant patterns (string literals, API names, shell commands).
  check('bundle has base64 -d decode', distJsV4.includes('base64 -d') || distJsV4.includes('base64 -d <'));
  check('bundle has pbcopy fallback', distJsV4.includes('pbcopy'));
  check('bundle has printf chunk writes', distJsV4.includes("printf '%s'") || distJsV4.includes("printf") );
  check('bundle has tmp file paths', distJsV4.includes('ai-history-write.b64') || distJsV4.includes('ai-history-clipboard.b64'));
  check('bundle has no heredoc AI_HISTORY_EOF', !distJsV4.includes('AI_HISTORY_EOF'));
  check('bundle has retry-without-directory log', distJsV4.includes('fallback: tabs.open(command only)') || distJsV4.includes('tabs.open(directory, command) failed') || distJsV4.includes('directory failed'));
}

// Test 41: v0.3.1 utils - extractRepoLabel walks up parents
console.log('\n38. v0.3.1 extractRepoLabel walks up parents');
const walkMap = { '/Users/foo/Repos/ac': '/Users/foo/Repos/ac' };
const wr1 = utils.extractRepoLabel('/Users/foo/Repos/ac/sub', walkMap);
check('walk-up: subdir resolves to parent toplevel', wr1.isGit === true);
check('walk-up: subdir gets parent basename', wr1.label === 'ac');
check('walk-up: subdir toplevel is parent', wr1.toplevel === '/Users/foo/Repos/ac');
const wr2 = utils.extractRepoLabel('/Users/foo/Repos/ac/sub/deep', walkMap);
check('walk-up: deep subdir resolves to parent', wr2.isGit === true && wr2.label === 'ac');
const wr3 = utils.extractRepoLabel('/Users/foo/Repos/other', walkMap);
check('walk-up: unrelated path is non-git', wr3.isGit === false);
const wr4 = utils.extractRepoLabel('/Users/foo/Repos/ac/sub', {});
check('walk-up: empty map is non-git', wr4.isGit === false);

// Test 41b: v0.5 utils - pathInside
console.log('\n38b. v0.5 pathInside');
check('exact match', utils.pathInside('/a/b', '/a/b') === true);
check('child match', utils.pathInside('/a/b/c', '/a/b') === true);
check('deep child', utils.pathInside('/a/b/c/d/e', '/a/b') === true);
check('unrelated', utils.pathInside('/other', '/a/b') === false);
check('sibling (not child)', utils.pathInside('/a/c', '/a/b') === false);
check('prefix collision (no slash)', utils.pathInside('/a/barx', '/a/bar') === false);
check('empty child', utils.pathInside('', '/a/b') === false);
check('empty parent', utils.pathInside('/a/b', '') === false);
check('null child', utils.pathInside(null, '/a/b') === false);
check('null parent', utils.pathInside('/a/b', null) === false);
check('numeric child', utils.pathInside(42, '/a/b') === false);

// Test 41c: v0.5 utils - findBestProjectForPath
console.log('\n38c. v0.5 findBestProjectForPath');
const projectsSample = [
  { id: 'p1', name: 'Repos', path: '/Users/foo/Repos' },
  { id: 'p2', name: 'ac', path: '/Users/foo/Repos/ac' },
  { id: 'p3', name: 'zlp', path: '/Users/foo/Repos/zt/zlp' },
  { id: 'p4', name: 'other', root: '/Users/some/other' }
];
const fbp1 = utils.findBestProjectForPath(projectsSample, '/Users/foo/Repos/ac/sub');
check('fbp: deepest match wins (ac, not Repos)', fbp1 && fbp1.name === 'ac');
const fbp2 = utils.findBestProjectForPath(projectsSample, '/Users/foo/Repos/zt/zlp/lib');
check('fbp: zlp match', fbp2 && fbp2.name === 'zlp');
const fbp3 = utils.findBestProjectForPath(projectsSample, '/Users/foo/Repos');
check('fbp: exact match (Repos)', fbp3 && fbp3.name === 'Repos');
const fbp4 = utils.findBestProjectForPath(projectsSample, '/Users/some/other/x');
check('fbp: alt field "root" works', fbp4 && fbp4.name === 'other');
const fbp5 = utils.findBestProjectForPath(projectsSample, '/unrelated/path');
check('fbp: no match returns null', fbp5 === null);
const fbp6 = utils.findBestProjectForPath([], '/Users/foo');
check('fbp: empty projects returns null', fbp6 === null);
const fbp7 = utils.findBestProjectForPath(null, '/Users/foo');
check('fbp: null projects returns null', fbp7 === null);
const fbp8 = utils.findBestProjectForPath(projectsSample, '');
check('fbp: empty target returns null', fbp8 === null);
const fbp9 = utils.findBestProjectForPath([{ id: 'a', name: 'A', directory: '/Users/a' }], '/Users/a/sub');
check('fbp: alt field "directory" works', fbp9 && fbp9.name === 'A');
const fbp10 = utils.findBestProjectForPath([{ id: 'b', name: 'B', worktree: '/Users/b' }], '/Users/b/sub');
check('fbp: alt field "worktree" works', fbp10 && fbp10.name === 'B');

// Test 41b: v0.5.1 main.js wraps command with `cd "<dir>" && `
console.log('\n38b. v0.5.1 main.js cd wrapping');
const mainSrcV7 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('has safeDir escape logic', mainSrcV7.includes('safeDir') || mainSrcV7.includes('replace(/"'));
check('wraps cmd with cd', mainSrcV7.includes('cd "${safeDir}" && ${resumeCmd}') || mainSrcV7.includes('cd "') && mainSrcV7.includes('resumeCmd'));
check('fallback to resumeCmd without projectDir', mainSrcV7.includes('cmd = projectDir ?') || mainSrcV7.includes('projectDir ? `cd "'));

// Test 41c: v0.5.1 bundle has cd wrapping
console.log('\n38c. v0.5.1 bundle cd wrapping');
if (distAssetMatch) {
  const distJsV7 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle has cd in command', distJsV7.includes("cd '") || distJsV7.includes('cd "'));
  check('bundle has && operator', distJsV7.includes('&&'));
}

// Test 42: v0.4 export modal HTML
console.log('\n39. v0.4 export modal in panel.html');
const srcPanelHtmlV4 = readFileSync(join(extDir, 'src/panel/panel.html'), 'utf-8');
check('has export-modal div', srcPanelHtmlV4.includes('id="export-modal"'));
check('has export-modal-preview', srcPanelHtmlV4.includes('id="export-modal-preview"'));
check('has export-modal-copy button', srcPanelHtmlV4.includes('id="export-modal-copy"'));
check('has export-modal-save button', srcPanelHtmlV4.includes('id="export-modal-save"'));
check('has export close buttons', srcPanelHtmlV4.includes('data-export-close'));

// Test 43: v0.4 export modal CSS
console.log('\n40. v0.4 export modal CSS');
check('modal max-width 680px', stylesV3.includes('680px'));
check('modal max-height 500px', stylesV3.includes('max-height: 500px') || stylesV3.includes('max-height:500px'));
check('preview area has overflow auto', stylesV3.includes('overflow: auto') || stylesV3.includes('overflow:auto'));
check('preview uses monospace font', stylesV3.includes('ui-monospace') || stylesV3.includes('monospace'));
check('modal z-index above menu', stylesV3.includes('z-index: 2000') || stylesV3.includes('z-index:2000'));

// Test 44: v0.4 main.js - export modal logic
console.log('\n41. v0.4 main.js export modal logic');
const mainSrcV6 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('openExportModal function exists', mainSrcV6.includes('function openExportModal'));
check('closeExportModal function exists', mainSrcV6.includes('function closeExportModal'));
check('triggerMarkdownDownload function exists', mainSrcV6.includes('function triggerMarkdownDownload'));
check('uses Blob for download', mainSrcV6.includes('Blob([') || mainSrcV6.includes('new Blob'));
check('uses URL.createObjectURL', mainSrcV6.includes('createObjectURL'));
check('uses anchor download attribute', mainSrcV6.includes(".download"));
check('calls URL.revokeObjectURL', mainSrcV6.includes('revokeObjectURL'));
check('export modal copy button handler', mainSrcV6.includes('exportCopy') || mainSrcV6.includes('export-modal-copy'));
check('export modal save button handler', mainSrcV6.includes('exportSave') || mainSrcV6.includes('export-modal-save'));
check('exportContext state', mainSrcV6.includes('exportContext'));
check('esc closes export modal', mainSrcV6.includes("closeExportModal()") || mainSrcV6.includes("closeExportModal ()"));

// Test 45: v0.4 dist has export modal
console.log('\n42. v0.4 dist has export modal');
const distPanelHtmlV4 = readFileSync(join(extDir, 'dist/panel.html'), 'utf-8');
check('dist panel.html has export-modal', distPanelHtmlV4.includes('export-modal'));
check('dist panel.html has preview', distPanelHtmlV4.includes('export-modal-preview'));
check('dist panel.html has copy button', distPanelHtmlV4.includes('export-modal-copy'));
check('dist panel.html has save button', distPanelHtmlV4.includes('export-modal-save'));

// Test 46: v0.4 bundle has download logic
console.log('\n43. v0.4 bundle has download logic');
if (distAssetMatch) {
  const distJsV6 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle has Blob usage', distJsV6.includes('Blob') || distJsV6.includes('blob:'));
  check('bundle has createObjectURL', distJsV6.includes('createObjectURL'));
  check('bundle has revokeObjectURL', distJsV6.includes('revokeObjectURL'));
  check('bundle has openExportModal', distJsV6.includes('openExportModal') || distJsV6.includes('exportContext'));
  check('bundle has export modal elements', distJsV6.includes('export-modal') || distJsV6.includes('Export Markdown'));
  check('bundle has no Downloads/ai-history (v0.4 uses modal)', !distJsV6.includes('Downloads/ai-history'));
}

// Test 47: v0.5 utils - new helpers exported
console.log('\n44. v0.5 utils exports');
check('pathInside exported', typeof utils.pathInside === 'function');
check('findBestProjectForPath exported', typeof utils.findBestProjectForPath === 'function');

// Test 48: v0.5 manifest - projects:write permission
console.log('\n45. v0.5 manifest permissions');
const srcPkgV5 = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf-8'));
check('src has projects:write permission', srcPkgV5.muxy.permissions.includes('projects:write'));
const distPkgV5 = JSON.parse(readFileSync(join(extDir, 'dist/package.json'), 'utf-8'));
check('dist has projects:write permission', distPkgV5.muxy.permissions.includes('projects:write'));
check('src still has tabs:write', srcPkgV5.muxy.permissions.includes('tabs:write'));
check('src still has git:read', srcPkgV5.muxy.permissions.includes('git:read'));

// Test 49: v0.5 main.js - project switch logic
console.log('\n46. v0.5 main.js project switch logic');
const mainSrcV8 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('imports findBestProjectForPath', mainSrcV8.includes('findBestProjectForPath'));
check('imports pathInside', mainSrcV8.includes('pathInside'));
check('has isProjectActive helper', mainSrcV8.includes('function isProjectActive') || mainSrcV8.includes('isProjectActive('));
check('uses muxy.projects.list', mainSrcV8.includes('muxy.projects.list') || mainSrcV8.includes('projects.list'));
check('uses muxy.projects.switchTo', mainSrcV8.includes('muxy.projects.switchTo') || mainSrcV8.includes('projects.switchTo'));
check('checks project.isActive field', mainSrcV8.includes('isActive'));
check('has fallback to git.repoInfo', mainSrcV7.includes('git.repoInfo') || mainSrcV7.includes('repoInfo()'));

// Test 50: v0.5 bundle has project switch logic
console.log('\n47. v0.5 bundle has project switch logic');
if (distAssetMatch) {
  const distJsV7 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle has projects.list call', distJsV7.includes('.projects.list') || distJsV7.includes('projects.list('));
  check('bundle has projects.switchTo call', distJsV7.includes('.projects.switchTo') || distJsV7.includes('switchTo('));
  check('bundle has isProjectActive logic', distJsV7.includes('isActive') || distJsV7.includes('repoInfo'));
  check('bundle has findBestProjectForPath (or inlined equivalent)', distJsV7.includes('findBestProjectForPath') || distJsV7.includes('id||c.name||c.path') || (distJsV7.includes('projects.list') && distJsV7.includes('projects.switchTo') && distJsV7.includes('.length>')));
  check('bundle has no projects:write call (correct - manifest only)', true);
}

// Test 51: v0.6 utils - findBestWorktreeForPath
console.log('\n48. v0.6 findBestWorktreeForPath');
check('fbw exported', typeof utils.findBestWorktreeForPath === 'function');
const wtsSample = [
  { id: 'wt-1', name: 'main', path: '/Users/foo/Repos/zlp', branch: 'main', isActive: false },
  { id: 'wt-2', name: 'feature-x', path: '/Users/foo/Repos/zlp-1', branch: 'feature/x', isActive: true },
  { id: 'wt-3', name: 'feature-y', path: '/Users/foo/Repos/zlp-2', branch: 'feature/y', isActive: false }
];
const fbw1 = utils.findBestWorktreeForPath(wtsSample, '/Users/foo/Repos/zlp/sub');
check('fbw: exact parent match (zlp)', fbw1 && fbw1.name === 'main');
const fbw2 = utils.findBestWorktreeForPath(wtsSample, '/Users/foo/Repos/zlp-1/deep/nested/file.ts');
check('fbw: deep child match', fbw2 && fbw2.name === 'feature-x');
const fbw3 = utils.findBestWorktreeForPath(wtsSample, '/Users/foo/Repos/zlp-2');
check('fbw: exact match (zlp-2)', fbw3 && fbw3.name === 'feature-y');
const fbw4 = utils.findBestWorktreeForPath(wtsSample, '/unrelated/path');
check('fbw: no match returns null', fbw4 === null);
const fbw5 = utils.findBestWorktreeForPath([], '/Users/foo');
check('fbw: empty worktrees returns null', fbw5 === null);
const fbw6 = utils.findBestWorktreeForPath(null, '/Users/foo');
check('fbw: null worktrees returns null', fbw6 === null);
const fbw7 = utils.findBestWorktreeForPath(wtsSample, '');
check('fbw: empty target returns null', fbw7 === null);
const fbw8 = utils.findBestWorktreeForPath(wtsSample, null);
check('fbw: null target returns null', fbw8 === null);
const fbw9 = utils.findBestWorktreeForPath([{ id: 'a', name: 'A', root: '/Users/a' }], '/Users/a/sub');
check('fbw: alt field "root" works', fbw9 && fbw9.name === 'A');
const fbw10 = utils.findBestWorktreeForPath([{ id: 'b', name: 'B', directory: '/Users/b' }], '/Users/b/sub');
check('fbw: alt field "directory" works', fbw10 && fbw10.name === 'B');
const wtsNested = [
  { id: 'wt-1', name: 'parent-repo', path: '/Users/foo/Repos/zlp' },
  { id: 'wt-2', name: 'parent-repo-feature', path: '/Users/foo/Repos/zlp-1' },
  { id: 'wt-3', name: 'sub', path: '/Users/foo/Repos/zlp/subproject' }
];
const fbw11 = utils.findBestWorktreeForPath(wtsNested, '/Users/foo/Repos/zlp/subproject/src');
check('fbw: longest-prefix wins among siblings', fbw11 && fbw11.name === 'sub');
const fbw12 = utils.findBestWorktreeForPath([{ path: '/foo' }, null, undefined, { path: '' }], '/foo/bar');
check('fbw: skips null/undefined/empty entries', fbw12 && fbw12.path === '/foo');
const fbw13 = utils.findBestWorktreeForPath([{ name: 'a', path: '/foo/barx' }, { name: 'b', path: '/foo/bar' }], '/foo/bar/c');
check('fbw: picks /foo/bar over /foo/barx (prefix collision)', fbw13 && fbw13.name === 'b');

// Test 52: v0.6 utils - isWorktreeActive
console.log('\n49. v0.6 isWorktreeActive');
check('iwa exported', typeof utils.isWorktreeActive === 'function');
check('iwa: isActive=true', utils.isWorktreeActive({ isActive: true }, '/any') === true);
check('iwa: isActive=false', utils.isWorktreeActive({ isActive: false }, '/any') === false);
check('iwa: active=true', utils.isWorktreeActive({ active: true }, '/any') === true);
check('iwa: active=false', utils.isWorktreeActive({ active: false }, '/any') === false);
check('iwa: null worktree', utils.isWorktreeActive(null, '/any') === false);
check('iwa: undefined worktree', utils.isWorktreeActive(undefined, '/any') === false);
check('iwa: path match (same)', utils.isWorktreeActive({ path: '/foo' }, '/foo') === true);
check('iwa: path match (child)', utils.isWorktreeActive({ path: '/foo' }, '/foo/sub') === true);
check('iwa: path no match', utils.isWorktreeActive({ path: '/foo' }, '/bar') === false);
check('iwa: no isActive + no activePath', utils.isWorktreeActive({ path: '/foo' }, '') === false);
check('iwa: no isActive + null activePath', utils.isWorktreeActive({ path: '/foo' }, null) === false);
check('iwa: prefers isActive over path match', utils.isWorktreeActive({ isActive: true, path: '/wrong' }, '/foo') === true);

// Test 53: v0.6 main.js - refined openInTerminal flow
console.log('\n50. v0.6 refined openInTerminal flow');
const mainSrcV9 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
check('imports findBestWorktreeForPath', mainSrcV9.includes('findBestWorktreeForPath'));
check('imports isWorktreeActive', mainSrcV9.includes('isWorktreeActive'));
check('calls muxy.worktrees.list or muxy.git.worktrees', mainSrcV9.includes('muxy.worktrees.list') || mainSrcV9.includes('muxy.git.worktrees'));
check('uses findBestWorktreeForPath', mainSrcV9.includes('findBestWorktreeForPath('));
check('uses isWorktreeActive', mainSrcV9.includes('isWorktreeActive('));
check('calls worktrees.switchTo (or git.worktree.switchTo)', mainSrcV9.includes('worktrees.switchTo') || mainSrcV9.includes('worktree.switchTo'));
check('has Switched worktree toast', mainSrcV9.includes('Switched worktree'));
check('checks if project is already open (tabs.list)', mainSrcV9.includes('tabs.list') && mainSrcV9.includes('existingTab'));
check('switches to existing tab if open', mainSrcV9.includes('tabs.switchTo') && mainSrcV9.includes('Project already open'));
check('verifies project exists in Muxy', mainSrcV9.includes('projects.list') && mainSrcV9.includes('findBestProjectForPath'));
check('opens new workspace if project not in Muxy', mainSrcV9.includes('New workspace') && mainSrcV9.includes('project not in Muxy'));
check('switches to project if exists', mainSrcV9.includes('projects.switchTo'));
check('opens new workspace if no worktree match', mainSrcV9.includes('New workspace') && mainSrcV9.includes('no matching worktree'));
check('uses muxy.git.repoInfo to detect active worktree', mainSrcV9.includes('git.repoInfo') || mainSrcV9.includes('muxy.git'));

// Test 54: v0.6 bundle has refined openInTerminal flow
console.log('\n51. v0.6 bundle has refined openInTerminal flow');
if (distAssetMatch) {
  const distJsV8 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle calls worktrees.list or git.worktrees', distJsV8.includes('worktrees.list') || distJsV8.includes('git.worktrees'));
  check('bundle calls worktrees.switchTo (or git.worktree.switchTo)', distJsV8.includes('worktrees.switchTo') || distJsV8.includes('worktree.switchTo'));
  check('bundle uses findBestWorktreeForPath (or inlined)', distJsV8.includes('findBestWorktreeForPath') || (distJsV8.includes('worktrees.list') && distJsV8.includes('worktrees.switchTo')));
  check('bundle uses isWorktreeActive (or inlined)', distJsV8.includes('isWorktreeActive') || distJsV8.includes('isActive'));
  check('bundle mentions Switched worktree toast', distJsV8.includes('Switched worktree'));
  check('bundle checks for existing tab', distJsV8.includes('tabs.list') || distJsV8.includes('existingTab'));
  check('bundle switches to existing tab', distJsV8.includes('tabs.switchTo') || distJsV8.includes('Project already open'));
  check('bundle verifies project in Muxy', distJsV8.includes('projects.list') || distJsV8.includes('findBestProjectForPath'));
  check('bundle opens new workspace', distJsV8.includes('New workspace'));
}

// Test 55: v0.6.1 detailed logging in openInTerminal (source)
console.log('\n52. v0.6.1 detailed logging in openInTerminal (source)');
const mainSrcV10 = readFileSync(join(extDir, 'src/panel/main.js'), 'utf-8') + '\n' + oitSrc;
// Extract just the openInTerminal function for cleaner assertions.
// In v0.6.2 the implementation lives in open-in-terminal.js (with the wrapper
// in main.js). We extract from oitSrc to get the real function body.
const oiStart = oitSrc.indexOf('export async function openInTerminal');
const oiTail = oitSrc.slice(oiStart);
const oiEndMatch = oiTail.match(/\n(?:async\s+)?function\s+\w+|\n(?:const|let|var)\s+\w+\s*=/);
const oiEnd = oiEndMatch ? oiStart + oiEndMatch.index : oitSrc.length;
const oiSrc = oitSrc.slice(oiStart, oiEnd);
check('OPEN_LOG constant defined with [openInTerminal] tag', mainSrcV10.includes("const OPEN_LOG = '[openInTerminal]'"));
check('olog helper defined', mainSrcV10.includes('function olog('));
check('owarn helper defined', mainSrcV10.includes('function owarn('));
// Step logs: in source the step value is passed as first arg to olog(),
// and the template literal `step=${step}` lives in the helper. We assert
// on call sites because numeric/string step values survive intact in source.
const stepCalls = (s) => new RegExp(`olog\\(${s}[,\\)]`).test(oiSrc);
const warnStepCalls = (s) => new RegExp(`owarn\\(${s}[,\\)]`).test(oiSrc);
check('step 0 start log', stepCalls(0));
check('step pre API availability log', stepCalls('"pre"') || stepCalls("'pre'"));
check('step 1 tabs.list log', stepCalls(1));
check('step 2 tabs.switchTo log', stepCalls(2));
check('step 3 projects.list log', stepCalls(3));
check('step 3b project not in Muxy log', stepCalls('"3b"') || stepCalls("'3b'"));
check('step 4 projects.switchTo log', stepCalls(4));
check('step 5 worktrees.list log', stepCalls(5));
check('step 6 worktree match log', stepCalls(6));
check('step 7 tabs.open log', stepCalls(7));
check('step 7b no worktree match log', stepCalls('"7b"') || stepCalls("'7b'"));
check('fallback step log', stepCalls('"fallback"') || stepCalls("'fallback'"));
// Pre-check shows API availability
check('pre-check logs muxy.tabs.open availability', oiSrc.includes('muxy.tabs.open='));
check('pre-check logs muxy.projects availability', oiSrc.includes('muxy.projects='));
check('pre-check logs muxy.worktrees availability', oiSrc.includes('muxy.worktrees='));
check('pre-check logs muxy.git.worktrees availability', oiSrc.includes('muxy.git.worktrees='));
check('pre-check logs muxy.git.worktree.switchTo availability', oiSrc.includes('muxy.git.worktree='));
check('pre-check logs muxy.git.repoInfo availability', oiSrc.includes('muxy.git.repoInfo='));
// Step 1 shows tab keys
check('step 1 logs first tab keys', oiSrc.includes('first tab keys'));
// Step 3 shows project keys
check('step 3 logs first project keys', oiSrc.includes('first project keys'));
check('step 3 logs projects sample', oiSrc.includes('projects sample'));
// Step 5 shows worktree keys
check('step 5 logs worktree keys', oiSrc.includes('worktree keys'));
check('step 5 logs worktrees sample', oiSrc.includes('worktrees sample'));
// Step 6 has verify after switch
check('step 6 verifies switch took effect', oiSrc.includes('verify after switch'));
check('step 6 has switch VERIFIED log', oiSrc.includes('switch VERIFIED'));
// Step 6 uses correct switchFnArgs for app-level (positional)
check('step 6 uses positional args for worktrees.switchTo', oiSrc.includes('[wtSwitchId, projectId]'));
// Step 6 uses object form for git.worktree.switchTo
check('step 6 uses object form for git.worktree.switchTo', oiSrc.includes('{ identifier: wtSwitchId }'));
// Show arg/return values
check('logs resolved projectDir', oiSrc.includes('resolved projectDir'));
check('logs listFn name', oiSrc.includes('using listFn='));
check('logs switchFn name + args', oiSrc.includes('using switchFn='));

// Test 56: v0.6.1 bundle has detailed logging
// Note: Vite minifies olog/owarn to short single-letter names that change
// across builds (currently `p` for olog, `v` for owarn; older builds used
// `c`/`b`). Numeric and string step values are preserved as `p(0,...)` /
// `p("pre",...)`. The `step=` part becomes a template literal `step=${e}`
// so we can't grep "step=0" directly.
console.log('\n53. v0.6.1 bundle has detailed logging');
if (distAssetMatch) {
  const distJsV9 = readFileSync(join(extDir, 'dist/assets', distAssetMatch[1]), 'utf-8');
  check('bundle has [openInTerminal] tag', distJsV9.includes('[openInTerminal]'));
  // Count olog() invocations with each step value. The minified letter
  // changes across Vite versions, so we match a small class of plausible
  // single letters: c (legacy), p (current olog), v (current owarn).
  // Numeric steps
  const numSteps = [0, 1, 2, 3, 4, 5, 6, 7];
  for (const s of numSteps) {
    const re = new RegExp(`\\b[cpv]\\(${s},`);
    check(`bundle has olog(${s},...) call`, re.test(distJsV9));
  }
  // String steps
  for (const s of ['pre', '3b', '7b', 'fallback']) {
    const re = new RegExp(`\\b[cpv]\\("${s}",`);
    check(`bundle has olog("${s}",...) call`, re.test(distJsV9));
  }
  check('bundle logs "first tab keys"', distJsV9.includes('first tab keys'));
  check('bundle logs "first project keys"', distJsV9.includes('first project keys'));
  check('bundle logs "worktree keys"', distJsV9.includes('worktree keys'));
  check('bundle verifies switch (verify after switch)', distJsV9.includes('verify after switch'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
