import {
  formatDate,
  formatTimestamp,
  escapeHtml,
  escapeSqlString,
  slugify,
  displayProject,
  buildMarkdown,
  buildRenameSql,
  applyCustomTitle,
  getVisibleConversations,
  paginate,
  uniqueProjects,
  decodeClaudeProject,
  extractRepoLabel,
  projectDisplayGroups,
  projectMatchesFilter,
  buildResumeCommand,
  chunkString,
  pathInside,
  findBestProjectForPath,
  findBestWorktreeForPath,
  isWorktreeActive,
  abbreviateHome,
  expandHome
} from './utils.js';
import {
  filterGroups,
  getPickerLabel,
  buildPickerItems,
  matchItem,
  findActiveIndex,
  selectProjectAndFilter as selectProjectAndFilterImpl
} from './project-picker.js';
import { openInTerminal as openInTerminalImpl, isProjectActive } from './open-in-terminal.js';

// HOME-relative paths are resolved at runtime via `getPaths()` (see below).
// We can't use `process.env.HOME` because the panel runs in a browser and the
// Vite/esbuild minifier rewrites `process.env` to an empty object literal, so
// any HOME reference would become `undefined` in the bundle. Instead we ask
// the host shell for `$HOME` via muxy.exec.
const PAGE_SIZE = 50;
const SIDECAR_KEY_PREFIX = (provider) => `${provider}:`;

const state = {
  provider: 'all',
  search: '',
  projectFilter: '',
  page: 1,
  pageSize: PAGE_SIZE,
  all: [],
  customTitles: {},
  gitToplevelMap: {},
  gitToplevelMapUpdated: 0,
  currentDetail: null,
  menuTargetId: null,
  menuView: 'main',
  menuAnchor: null,
  exportContext: null,
  home: '',
  pickerOpen: false,
  pickerHighlight: 0,
  pickerQuery: '',
  pickerItems: null
};

const els = {
  refresh: document.getElementById('refresh'),
  search: document.getElementById('search'),
  status: document.getElementById('status'),
  conversations: document.getElementById('conversations'),
  loadMoreWrap: document.getElementById('load-more-wrap'),
  loadMore: document.getElementById('load-more'),
  detail: document.getElementById('detail'),
  back: document.getElementById('back'),
  detailTitle: document.getElementById('detail-title'),
  detailMeta: document.getElementById('detail-meta'),
  messages: document.getElementById('messages'),
  tabButtons: document.querySelectorAll('.tab'),
  filters: document.querySelector('.filters'),
  tabs: document.querySelector('.tabs'),
  menuPopover: document.getElementById('menu-popover'),
  exportModal: document.getElementById('export-modal'),
  exportPreview: document.getElementById('export-modal-preview'),
  exportCopy: document.getElementById('export-modal-copy'),
  exportSave: document.getElementById('export-modal-save'),
  projectPicker: document.getElementById('project-picker'),
  projectPickerPopover: document.getElementById('project-picker-popover'),
  projectPickerSearch: document.getElementById('project-picker-search'),
  projectPickerList: document.getElementById('project-picker-list')
};

function muxyExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    if (typeof muxy === 'undefined' || !muxy.exec) {
      resolve({ exitCode: -1, stdout: '', stderr: 'muxy.exec not available' });
      return;
    }
    const array = Array.isArray(cmd) ? cmd : [cmd, ...args];
    try {
      const result = muxy.exec(array, opts);
      resolve(result || { exitCode: -1, stdout: '', stderr: 'no result' });
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: e.message || String(e) });
    }
  });
}

// Resolves the user's home directory by running `printf %s "$HOME"` in the
// host shell. The Promise is cached so subsequent callers (including
// concurrent first callers) share a single shell invocation. Returns '' on
// failure (and logs a warning) — callers that need a non-empty home should
// check and surface a diagnostic error to the user.
let _homeCache = null;
function getHome() {
  if (_homeCache) return _homeCache;
  _homeCache = (async () => {
    const result = await muxyExec(['/bin/sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 2e3 });
    if (result.exitCode !== 0) {
      console.warn(`[ai-history] HOME resolution failed: exitCode=${result.exitCode} stderr=${result.stderr || ''}`);
      return '';
    }
    const home = (result.stdout || '').trim();
    state.home = home;
    return home;
  })();
  return _homeCache;
}

// Returns the lazy, HOME-relative paths used throughout the panel. Each call
// re-derives from the cached `getHome()` value.
async function getPaths() {
  const home = await getHome();
  return {
    CLAUDE_PROJECTS: `${home}/.claude/projects`,
    OPENCODE_DB: `${home}/.local/share/opencode/opencode.db`,
    SIDECAR_PATH: `${home}/.config/muxy/extensions/ai-history/custom-titles.json`
  };
}

function muxyExecShell(shellCommand, opts = {}) {
  return new Promise((resolve) => {
    if (typeof muxy === 'undefined' || !muxy.exec) {
      resolve({ exitCode: -1, stdout: '', stderr: 'muxy.exec not available' });
      return;
    }
    try {
      const result = muxy.exec({ shell: shellCommand }, opts);
      resolve(result || { exitCode: -1, stdout: '', stderr: 'no result' });
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: e.message || String(e) });
    }
  });
}

function muxyToast(opts) {
  if (typeof muxy !== 'undefined' && muxy.toast) {
    try {
      muxy.toast(opts);
    } catch (e) {
      console.warn('toast failed', e);
    }
  }
}

// Encodes a Unicode string to base64 in the browser. Safe for the
// chunked writer: btoa(unescape(encodeURIComponent(s))) handles any UTF-8.
function base64Encode(s) {
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(s)));
  }
  return Buffer.from(s, 'utf-8').toString('base64');
}

const WRITE_CHUNK_SIZE = 60 * 1024;

// Writes `content` to `filePath` by streaming it as base64 in 60KB chunks via
// `printf '%s' >> tmp.b64` and then a single `base64 -d` decode. Avoids ARG_MAX
// for large content and the heredoc hang that hits Muxy's shell exec.
//
// Each chunk is a separate muxy.exec call. Muxy will show a "Allow this
// command to run?" dialog the first time per command shape; the user can click
// "Allow & remember" once and subsequent chunks (same command shape) won't
// prompt.
async function writeLargeStringToFile(filePath, content, { onProgress } = {}) {
  const b64 = base64Encode(content);
  const tmp = '/tmp/ai-history-write.b64';

  // Clean any leftover from a previous run
  const cleanup = await muxyExec('/bin/rm', ['-f', tmp], { timeoutMs: 2e3 });
  if (cleanup.exitCode !== 0) {
    return { ok: false, error: `cleanup failed: ${cleanup.stderr || ''}` };
  }

  const chunks = chunkString(b64, WRITE_CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (onProgress) onProgress(i + 1, chunks.length);
    const res = await muxyExec('/bin/sh', ['-c', `printf '%s' '${chunk}' >> '${tmp}'`], { timeoutMs: 5e3 });
    if (res.exitCode !== 0) {
      return { ok: false, error: `chunk ${i + 1}/${chunks.length} failed: ${res.stderr || ''}` };
    }
  }

  // Make sure parent dir exists, then decode + remove tmp
  const dir = filePath.replace(/\/[^/]+$/, '');
  const dirRes = await muxyExec('/bin/mkdir', ['-p', dir], { timeoutMs: 3e3 });
  if (dirRes.exitCode !== 0) {
    return { ok: false, error: `mkdir failed: ${dirRes.stderr || ''}` };
  }
  const finalRes = await muxyExec('/bin/sh', ['-c', `/usr/bin/base64 -d < '${tmp}' > '${filePath}' && /bin/rm -f '${tmp}'`], { timeoutMs: 10e3 });
  if (finalRes.exitCode !== 0) {
    return { ok: false, error: `decode failed: ${finalRes.stderr || ''}` };
  }
  return { ok: true, chunks: chunks.length };
}

// Pipes `content` to the macOS pasteboard by writing it to a temp file in
// 60KB base64 chunks and then `pbcopy < tmp`. Avoids the shell-escape issues
// of `printf '%s' ${JSON.stringify(s)} | pbcopy` and the heredoc hang for
// large content.
async function copyLargeStringToClipboard(content) {
  const b64 = base64Encode(content);
  const tmp = '/tmp/ai-history-clipboard.b64';

  const cleanup = await muxyExec('/bin/rm', ['-f', tmp], { timeoutMs: 2e3 });
  if (cleanup.exitCode !== 0) {
    return { ok: false, error: `cleanup failed: ${cleanup.stderr || ''}` };
  }

  const chunks = chunkString(b64, WRITE_CHUNK_SIZE);
  for (const chunk of chunks) {
    const res = await muxyExec('/bin/sh', ['-c', `printf '%s' '${chunk}' >> '${tmp}'`], { timeoutMs: 5e3 });
    if (res.exitCode !== 0) {
      return { ok: false, error: `chunk write failed: ${res.stderr || ''}` };
    }
  }
  const pbcopy = await muxyExec('/bin/sh', ['-c', `/usr/bin/base64 -d < '${tmp}' | /usr/bin/pbcopy && /bin/rm -f '${tmp}'`], { timeoutMs: 5e3 });
  if (pbcopy.exitCode !== 0) {
    return { ok: false, error: `pbcopy failed: ${pbcopy.stderr || ''}` };
  }
  return { ok: true };
}

function setStatus(text, kind = 'info') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function renderContent(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, (m, code) => `<pre class="code"><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s_])_([^_\n]+)_(?=$|[\s.,;:])/g, '$1<em>$2</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function refreshPickerButton() {
  if (!els.projectPicker) return;
  const groups = projectDisplayGroups(uniqueProjects(state.all), state.gitToplevelMap);
  const home = state.home || '';
  const label = getPickerLabel(state.projectFilter, groups, home);
  els.projectPicker.textContent = label;
  els.projectPicker.title = label;
}

function openProjectPicker() {
  if (!els.projectPickerPopover) return;
  state.pickerOpen = true;
  state.pickerQuery = '';
  state.pickerHighlight = 0;
  renderPickerList();
  els.projectPickerPopover.classList.remove('hidden');
  if (els.projectPicker) {
    const rect = els.projectPicker.getBoundingClientRect();
    els.projectPickerPopover.style.left = `${Math.max(4, rect.left)}px`;
    els.projectPickerPopover.style.top = `${rect.bottom + 4}px`;
  }
  if (els.projectPickerSearch) {
    setTimeout(() => els.projectPickerSearch.focus(), 0);
  }
}

function closeProjectPicker() {
  if (!els.projectPickerPopover) return;
  state.pickerOpen = false;
  els.projectPickerPopover.classList.add('hidden');
  if (els.projectPickerSearch) els.projectPickerSearch.value = '';
}

function renderPickerList() {
  if (!els.projectPickerList) return;
  const groups = projectDisplayGroups(uniqueProjects(state.all), state.gitToplevelMap);
  const filtered = filterGroups(groups, state.pickerQuery);
  const allGroups = {
    git: filtered.git.map((g) => ({ ...g, count: countConversationsForProject(g.toplevel || g.project) })),
    nonGit: filtered.nonGit.map((g) => ({ ...g, count: countConversationsForProject(g.project) }))
  };
  const items = buildPickerItems(allGroups, state.projectFilter);
  state.pickerItems = items;
  state.pickerHighlight = findActiveIndex(items, state.projectFilter);
  els.projectPickerList.innerHTML = items.map((item, i) => renderPickerItemHTML(item, i)).join('');
}

function renderPickerItemHTML(item, i) {
  const activeClass = i === state.pickerHighlight ? ' active' : '';
  if (item.kind === 'project-header' || item.kind === 'path-header') {
    return `<div class="picker-section-header">${escapeHtml(item.label)}</div>`;
  }
  const check = item.active ? '<span class="picker-check">✓</span>' : '<span class="picker-check"></span>';
  const count = item.count != null ? `<span class="picker-count">${item.count}</span>` : '';
  const cls = item.kind === 'all' ? 'picker-item all' : `picker-item ${item.kind}`;
  return `<button class="${cls}${activeClass}" data-index="${i}" data-value="${escapeHtml(item.value || '')}" type="button">
    ${check}
    <span class="picker-label">${escapeHtml(item.label)}</span>
    ${count}
  </button>`;
}

function countConversationsForProject(projectPath) {
  if (!projectPath) return state.all.length;
  return state.all.filter((c) => projectMatchesFilter(c.project, projectPath)).length;
}

function selectPickerItem(index) {
  if (!state.pickerItems) return;
  const item = state.pickerItems[index];
  if (!item) return;
  if (item.kind === 'project-header' || item.kind === 'path-header') return;
  closeProjectPicker();
  // Fire-and-forget: the helper applies the filter synchronously and
  // performs the best-effort auto-switch asynchronously.
  selectProjectAndFilter(item.value || '');
}

// Thin wrapper that injects the real DOM, Muxy, and state deps. Kept
// synchronous-shaped (returns a Promise) so the caller can fire-and-forget.
function selectProjectAndFilter(path) {
  return selectProjectAndFilterImpl({
    state,
    muxy,
    els,
    refreshPickerButton,
    renderList,
    setStatus,
    findBestProjectForPath,
    isProjectActive,
    pathInside
  }, path);
}

async function gitToplevel(path) {
  const res = await muxyExec('/usr/bin/git', ['-C', path, 'rev-parse', '--show-toplevel'], { timeoutMs: 6e3 });
  if (res.exitCode !== 0) {
    // exit 128 = not a git repo (expected for non-git paths); other codes = error
    if (res.exitCode !== 128) {
      console.warn(`[gitToplevel] unexpected exit ${res.exitCode} for ${path}: ${(res.stderr || '').slice(0, 100)}`);
    }
    return null;
  }
  const t = (res.stdout || '').trim();
  return t || null;
}

async function loadProjectLabels(force = false) {
  const projects = uniqueProjects(state.all);
  const decodedPaths = new Set();
  for (const p of projects) {
    const decoded = decodeClaudeProject(p, state.home || '');
    if (decoded) decodedPaths.add(decoded);
  }
  // Cache invalidation: re-scan if forced, or if there are new paths we haven't seen
  const knownPaths = new Set(Object.keys(state.gitToplevelMap));
  const hasNewPaths = Array.from(decodedPaths).some((p) => !knownPaths.has(p));
  if (!force && !hasNewPaths && state.gitToplevelMapUpdated > 0) {
    return; // cache is fresh
  }
  console.log(`[loadProjectLabels] scanning ${decodedPaths.size} path(s) (force=${force}, newPaths=${hasNewPaths})`);
  const entries = await Promise.all(
    Array.from(decodedPaths).map(async (path) => {
      const top = await gitToplevel(path);
      return [path, top];
    })
  );
  const map = {};
  for (const [path, top] of entries) {
    if (top) map[path] = top;
  }
  state.gitToplevelMap = map;
  state.gitToplevelMapUpdated = Date.now();
  console.log(`[loadProjectLabels] found ${Object.keys(map).length} git repo(s) of ${decodedPaths.size} path(s)`);
}

function renderList() {
  const visibleAll = getVisibleConversations(state.all, {
    provider: state.provider,
    projectFilter: state.projectFilter,
    search: state.search
  }).map((c) => applyCustomTitle(c, state.customTitles));
  refreshPickerButton();
  if (state.all.length === 0) {
    els.conversations.innerHTML = '<div class="empty">No conversations found</div>';
    els.loadMoreWrap.classList.add('hidden');
    return;
  }
  if (visibleAll.length === 0) {
    els.conversations.innerHTML = '<div class="empty">No conversations match your filters</div>';
    els.loadMoreWrap.classList.add('hidden');
    return;
  }
  const home = state.home || '';
  const { items, hasMore, remaining } = paginate(visibleAll, state.page, state.pageSize);
  els.conversations.innerHTML = items
    .map(
      (c) => {
        const decodedPath = decodeClaudeProject(c.project || '', home);
        const displayPath = abbreviateHome(decodedPath, home) || displayProject(c.project);
        return `
      <div class="conv" data-provider="${c.provider}" data-id="${escapeHtml(c.id)}" data-file="${escapeHtml(c.file || '')}">
        <button class="conv-menu-trigger" type="button" aria-label="Menu" data-menu-id="${escapeHtml(c.id)}">⋮</button>
        <div class="conv-header">
          <span class="conv-provider ${c.provider}">${c.provider === 'claude' ? 'C' : 'OC'}</span>
          <span class="conv-title">${escapeHtml(c.title || '(untitled)')}</span>
        </div>
        <div class="conv-meta">
          <span class="conv-project" title="${escapeHtml(decodedPath)}">${escapeHtml(displayPath)}</span>
          <span class="conv-time">${escapeHtml(formatDate(c.lastTimestamp))}</span>
        </div>
        <div class="conv-preview">${escapeHtml(c.preview || '')}</div>
      </div>
    `;
      }
    )
    .join('');
  if (hasMore) {
    els.loadMoreWrap.classList.remove('hidden');
    els.loadMore.textContent = `Load more (${remaining} remaining)`;
  } else {
    els.loadMoreWrap.classList.add('hidden');
  }
}

async function readClaudeSession(filePath) {
  const result = await muxyExec('/bin/cat', [filePath], { timeoutMs: 10e3 });
  if (result.exitCode !== 0) return null;
  const text = result.stdout || '';
  const lines = text.split('\n');
  let firstUser = '';
  let lastTs = null;
  let firstTs = null;
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.isSidechain) continue;
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      count += 1;
      if (!firstTs && rec.timestamp) firstTs = rec.timestamp;
      if (rec.timestamp) lastTs = rec.timestamp;
      if (!firstUser && rec.type === 'user' && rec.message) {
        const content = rec.message.content;
        if (typeof content === 'string') firstUser = content;
        else if (Array.isArray(content)) {
          const textBlock = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
          if (textBlock) firstUser = textBlock.text;
        }
      }
    } catch {
      // skip
    }
  }
  if (count === 0) return null;
  const filename = filePath.split('/').pop();
  const sessionId = filename.replace('.jsonl', '');
  const projectName = filePath.split('/').slice(-2, -1)[0];
  return {
    provider: 'claude',
    id: sessionId,
    project: projectName,
    file: filePath,
    title: (firstUser || '(untitled)').slice(0, 120).replace(/\s+/g, ' ').trim(),
    preview: (firstUser || '').slice(0, 240).replace(/\s+/g, ' ').trim(),
    messageCount: count,
    firstTimestamp: firstTs,
    lastTimestamp: lastTs
  };
}

async function readClaudeSessionMessages(filePath) {
  const result = await muxyExec('/bin/cat', [filePath], { timeoutMs: 15e3 });
  if (result.exitCode !== 0) return [];
  const text = result.stdout || '';
  const lines = text.split('\n');
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.isSidechain) continue;
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      const content = rec.message ? rec.message.content : null;
      let textContent = '';
      if (typeof content === 'string') textContent = content;
      else if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.type === 'tool_use') {
            parts.push(`[tool: ${block.name || 'unknown'}]`);
          }
        }
        textContent = parts.join('\n').trim();
      }
      if (!textContent) continue;
      messages.push({
        uuid: rec.uuid,
        role: rec.message.role || rec.type,
        content: textContent,
        timestamp: rec.timestamp
      });
    } catch {
      // skip
    }
  }
  return messages;
}

async function listClaudeConversations() {
  const { CLAUDE_PROJECTS } = await getPaths();
  const projectsRes = await muxyExec('/bin/ls', ['-1', CLAUDE_PROJECTS], { timeoutMs: 5e3 });
  if (projectsRes.exitCode !== 0) return [];
  const projects = (projectsRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);

  const sessions = [];
  for (const project of projects) {
    const projectDir = `${CLAUDE_PROJECTS}/${project}`;
    const findRes = await muxyExec('/usr/bin/find', [projectDir, '-maxdepth', '1', '-name', '*.jsonl', '-type', 'f'], { timeoutMs: 5e3 });
    if (findRes.exitCode !== 0) continue;
    const files = (findRes.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const file of files) {
      const session = await readClaudeSession(file);
      if (session) sessions.push(session);
    }
  }
  return sessions;
}

async function readOpencodeSessions() {
  const { OPENCODE_DB } = await getPaths();
  const sql = `SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 500`;
  const result = await muxyExec('/usr/bin/sqlite3', ['-json', OPENCODE_DB, sql], { timeoutMs: 15e3 });
  if (result.exitCode !== 0) return [];
  const text = (result.stdout || '').trim();
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    const home = state.home || '';
    return rows.map((r) => ({
      provider: 'opencode',
      id: r.id,
      project: r.directory ? expandHome(r.directory, home) : '',
      title: (r.title || '(untitled)').slice(0, 120),
      preview: (r.title || '').slice(0, 240),
      messageCount: 0,
      firstTimestamp: new Date(r.time_created).toISOString(),
      lastTimestamp: new Date(r.time_updated).toISOString()
    }));
  } catch {
    return [];
  }
}

async function readOpencodeMessages(sessionId) {
  const { OPENCODE_DB } = await getPaths();
  const safeId = escapeSqlString(sessionId);
  const sql = `SELECT m.id, m.time_created, p.data FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${safeId}' ORDER BY m.time_created ASC, p.id ASC`;
  const result = await muxyExec('/usr/bin/sqlite3', ['-json', OPENCODE_DB, sql], { timeoutMs: 15e3 });
  if (result.exitCode !== 0) return [];
  const text = (result.stdout || '').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.id)) {
      byMessage.set(row.id, { id: row.id, timeCreated: row.time_created, text: '' });
    }
    if (row.data) {
      try {
        const part = JSON.parse(row.data);
        if (part.type === 'text' && typeof part.text === 'string') {
          const msg = byMessage.get(row.id);
          if (!msg.text) msg.text = part.text;
        }
      } catch {
        // skip
      }
    }
  }
  const messages = [];
  for (const m of byMessage.values()) {
    if (m.text) {
      messages.push({
        uuid: m.id,
        role: 'message',
        content: m.text,
        timestamp: new Date(m.timeCreated).toISOString()
      });
    }
  }
  return messages;
}

async function loadCustomTitles() {
  const { SIDECAR_PATH } = await getPaths();
  const result = await muxyExec('/bin/cat', [SIDECAR_PATH], { timeoutMs: 3e3 });
  if (result.exitCode !== 0 || !result.stdout) return {};
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // corrupted sidecar, ignore
  }
  return {};
}

async function saveCustomTitles() {
  const { SIDECAR_PATH } = await getPaths();
  const json = JSON.stringify(state.customTitles, null, 2);
  const result = await writeLargeStringToFile(SIDECAR_PATH, json);
  if (!result.ok) {
    console.warn('save custom titles failed', result.error);
    return false;
  }
  return true;
}

async function loadConversations() {
  setStatus('Loading...', 'info');
  els.conversations.innerHTML = '';
  state.page = 1;
  try {
    const home = await getHome();
    if (!home) {
      setStatus('Could not resolve HOME directory. Check the Muxy extension logs.', 'error');
      state.all = [];
      renderList();
      return;
    }
    state.customTitles = await loadCustomTitles();
    const [claude, opencode] = await Promise.all([
      listClaudeConversations().catch((e) => { console.warn('claude list error', e); return []; }),
      readOpencodeSessions().catch((e) => { console.warn('opencode list error', e); return []; })
    ]);
    state.all = [
      ...claude.map((c) => ({ ...c, provider: 'claude' })),
      ...opencode.map((c) => ({ ...c, provider: 'opencode' }))
    ];
    await loadProjectLabels(true);
    const total = state.all.length;
    if (total === 0) {
      setStatus('No conversations found. Check that Claude Code or OpenCode are installed.', 'warn');
    } else {
      setStatus(`${total} conversation${total === 1 ? '' : 's'} (${claude.length} Claude · ${opencode.length} OpenCode)`, 'ok');
    }
    renderList();
    refreshPickerButton();
  } catch (e) {
    setStatus(`Error: ${e.message || e}`, 'error');
  }
}

async function showDetail(provider, id, file) {
  setStatus('Loading messages...', 'info');
  try {
    let messages;
    if (provider === 'claude') {
      messages = await readClaudeSessionMessages(file);
    } else if (provider === 'opencode') {
      messages = await readOpencodeMessages(id);
    } else {
      throw new Error('unknown provider');
    }
    const visible = getVisibleConversations(state.all, {
      provider: state.provider,
      projectFilter: state.projectFilter,
      search: state.search
    }).map((c) => applyCustomTitle(c, state.customTitles));
    const conv = visible.find((c) => c.id === id && c.provider === provider) ||
      state.all.find((c) => c.id === id && c.provider === provider);
    state.currentDetail = { provider, id, file, conv, messages };
    renderDetail();
  } catch (e) {
    setStatus(`Error: ${e.message || e}`, 'error');
  }
}

function renderDetail() {
  if (!state.currentDetail) return;
  const { conv, messages } = state.currentDetail;
  els.conversations.classList.add('hidden');
  els.loadMoreWrap.classList.add('hidden');
  els.filters.classList.add('hidden');
  els.tabs.classList.add('hidden');
  els.detail.classList.remove('hidden');
  els.detailTitle.textContent = (conv && conv.title) || '(untitled)';
  const meta = [];
  if (conv) {
    if (conv.lastTimestamp) meta.push(formatDate(conv.lastTimestamp));
  }
  meta.push(`${messages.length} message${messages.length === 1 ? '' : 's'}`);
  els.detailMeta.textContent = meta.join(' · ');

  if (conv && conv.project) {
    const home = state.home || '';
    const decoded = decodeClaudeProject(conv.project, home);
    const displayPath = abbreviateHome(decoded, home) || decoded;
    const segments = displayPath.split('/').filter(Boolean);
    const crumbs = [];
    let running = '';
    segments.forEach((seg, i) => {
      if (i === 0 && seg === '~') {
        running = home;
        crumbs.push({ label: '~', path: home, isHome: true });
      } else if (i === 0 && seg.startsWith('~')) {
        const rest = seg.slice(1);
        running = home + '/' + rest;
        crumbs.push({ label: '~', path: home, isHome: true });
        crumbs.push({ label: rest, path: running });
      } else {
        running = running ? running + '/' + seg : '/' + seg;
        crumbs.push({ label: seg, path: running });
      }
    });
    const crumbHTML = crumbs.map((c) =>
      `<button class="crumb" data-path="${escapeHtml(c.path || '')}" type="button">${escapeHtml(c.label)}</button>`
    ).join('<span class="crumb-sep">/</span>');
    let crumbContainer = document.getElementById('detail-breadcrumb');
    if (!crumbContainer) {
      crumbContainer = document.createElement('div');
      crumbContainer.id = 'detail-breadcrumb';
      crumbContainer.className = 'breadcrumb';
      els.detailMeta.parentNode.insertBefore(crumbContainer, els.detailMeta);
    }
    crumbContainer.innerHTML = crumbHTML;
    crumbContainer.classList.remove('hidden');
  } else {
    const existing = document.getElementById('detail-breadcrumb');
    if (existing) existing.classList.add('hidden');
  }

  if (messages.length === 0) {
    els.messages.innerHTML = '<div class="empty">No messages</div>';
    setStatus('No messages found', 'warn');
    return;
  }
  els.messages.innerHTML = messages
    .map(
      (m) => `
      <div class="msg">
        <div class="msg-header">
          <span class="msg-role ${m.role}">${escapeHtml(m.role)}</span>
          <span class="msg-time">${escapeHtml(formatTimestamp(m.timestamp))}</span>
        </div>
        <div class="msg-content">${renderContent(m.content)}</div>
      </div>
    `
    )
    .join('');
  setStatus(`${messages.length} messages loaded`, 'ok');
}

function showList() {
  state.currentDetail = null;
  els.detail.classList.add('hidden');
  els.conversations.classList.remove('hidden');
  els.filters.classList.remove('hidden');
  els.tabs.classList.remove('hidden');
  renderList();
}

async function copyMarkdownToClipboard(conv, messages) {
  const markdown = buildMarkdown(conv, messages);
  // Prefer native Clipboard API; fall back to pbcopy via chunked base64.
  let ok = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(markdown);
      ok = true;
    } catch (e) {
      console.warn('clipboard write failed', e);
    }
  }
  if (!ok) {
    const res = await copyLargeStringToClipboard(markdown);
    ok = res.ok;
    if (!ok) console.warn('pbcopy fallback failed', res.error);
  }
  if (ok) {
    muxyToast({ title: 'Copied to clipboard', body: `${conv.provider} · ${conv.id.slice(0, 8)}`, variant: 'info' });
    setStatus('Copied markdown to clipboard', 'ok');
  } else {
    muxyToast({ title: 'Copy failed', body: 'Could not access clipboard', variant: 'error' });
    setStatus('Copy failed', 'error');
  }
}

// Centralized logging helper for openInTerminal.
// Tagged output is easy to grep in Muxy's extension log file.
const OPEN_LOG = '[openInTerminal]';
function olog(step, msg, extra) {
  if (extra !== undefined) {
    console.log(`${OPEN_LOG} step=${step} ${msg}`, extra);
  } else {
    console.log(`${OPEN_LOG} step=${step} ${msg}`);
  }
}
function owarn(step, msg, extra) {
  if (extra !== undefined) {
    console.warn(`${OPEN_LOG} step=${step} ${msg}`, extra);
  } else {
    console.warn(`${OPEN_LOG} step=${step} ${msg}`);
  }
}

async function openInTerminal(provider, id) {
  return openInTerminalImpl({
    muxy,
    toast: muxyToast,
    setStatus,
    state,
    log: { olog, owarn },
    getVisibleConversations,
    applyCustomTitle,
    decodeClaudeProject,
    buildResumeCommand,
    findBestProjectForPath,
    findBestWorktreeForPath,
    isWorktreeActive,
    pathInside
  }, provider, id);
}

async function renameConversation(provider, id, newTitle) {
  const trimmed = (newTitle || '').trim();
  if (!trimmed) {
    muxyToast({ title: 'Rename failed', body: 'Title cannot be empty', variant: 'error' });
    return false;
  }
  const key = SIDECAR_KEY_PREFIX(provider) + id;
  if (provider === 'opencode') {
    const { OPENCODE_DB } = await getPaths();
    const sql = buildRenameSql(id, trimmed);
    const res = await muxyExec('/usr/bin/sqlite3', [OPENCODE_DB, sql], { timeoutMs: 5e3 });
    if (res.exitCode !== 0) {
      muxyToast({ title: 'Rename failed', body: res.stderr || 'sqlite error', variant: 'error' });
      return false;
    }
    state.all = state.all.map((c) =>
      c.provider === 'opencode' && c.id === id ? { ...c, title: trimmed, preview: trimmed.slice(0, 240) } : c
    );
  } else {
    state.customTitles[key] = trimmed;
    const ok = await saveCustomTitles();
    if (!ok) {
      delete state.customTitles[key];
      muxyToast({ title: 'Rename failed', body: 'Could not save sidecar', variant: 'error' });
      return false;
    }
    state.all = state.all.map((c) =>
      c.provider === 'claude' && c.id === id ? { ...c, title: trimmed, preview: trimmed.slice(0, 240) } : c
    );
  }
  muxyToast({ title: 'Renamed', body: trimmed.slice(0, 60), variant: 'info' });
  setStatus(`Renamed to "${trimmed.slice(0, 40)}"`, 'ok');
  renderList();
  return true;
}

function startInlineRename(card) {
  if (!card) return;
  const titleSpan = card.querySelector('.conv-title');
  if (!titleSpan) return;
  const currentText = titleSpan.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-title-input';
  input.value = currentText === '(untitled)' ? '' : currentText;
  input.maxLength = 200;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newVal = input.value;
    const span = document.createElement('span');
    span.className = 'conv-title';
    const provider = card.dataset.provider;
    const id = card.dataset.id;
    if (commit && newVal.trim() && newVal !== currentText) {
      const ok = await renameConversation(provider, id, newVal);
      span.textContent = ok ? newVal : currentText;
    } else {
      span.textContent = currentText;
    }
    input.replaceWith(span);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function openMenu(trigger) {
  const card = trigger.closest('.conv');
  if (!card) return;
  state.menuTargetId = card.dataset.id;
  state.menuView = 'main';
  state.menuAnchor = trigger;
  renderMenu();
}

function renderMenu() {
  const trigger = state.menuAnchor;
  if (!trigger) return;
  const pop = els.menuPopover;
  if (state.menuView === 'main') {
    pop.innerHTML = `
      <button class="menu-item" data-action="view" type="button">View</button>
      <button class="menu-item" data-action="copy-path" type="button">Copy path</button>
      <div class="menu-separator"></div>
      <button class="menu-item" data-action="export" type="button">
        <span>Export</span>
        <span class="arrow">▶</span>
      </button>
      <button class="menu-item" data-action="rename" type="button">Rename</button>
    `;
  } else if (state.menuView === 'export') {
    pop.innerHTML = `
      <div class="menu-header">
        <button class="back" data-action="back" type="button" aria-label="Back">←</button>
        <span>Export</span>
      </div>
      <button class="menu-item" data-action="copy-md" type="button">Copy to Clipboard</button>
      <button class="menu-item" data-action="save-md" type="button">Save as Markdown…</button>
    `;
  }
  pop.classList.remove('hidden');
  positionMenu(trigger, pop);
}

function positionMenu(trigger, pop) {
  const rect = trigger.getBoundingClientRect();
  const popWidth = 180;
  const popHeight = pop.offsetHeight || 130;
  let left = rect.right - popWidth;
  let top = rect.bottom + 4;
  if (left < 4) left = 4;
  if (left + popWidth > window.innerWidth - 4) left = window.innerWidth - popWidth - 4;
  if (top + popHeight > window.innerHeight - 4) top = rect.top - popHeight - 4;
  if (top < 4) top = 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closeMenu() {
  els.menuPopover.classList.add('hidden');
  els.menuPopover.innerHTML = '';
  state.menuTargetId = null;
  state.menuView = 'main';
  state.menuAnchor = null;
}

async function handleMenuAction(action) {
  const id = state.menuTargetId;
  const card = id ? document.querySelector(`.conv[data-id="${CSS.escape(id)}"]`) : null;
  const provider = card ? card.dataset.provider : null;
  const file = card ? (card.dataset.file || null) : null;

  if (action === 'export') {
    state.menuView = 'export';
    renderMenu();
    return;
  }
  if (action === 'back') {
    state.menuView = 'main';
    renderMenu();
    return;
  }
  if (action === 'view') {
    closeMenu();
    if (provider && id && file != null) showDetail(provider, id, file);
    return;
  }
  if (action === 'copy-path') {
    closeMenu();
    const conv = state.all.find((c) => c.id === id && c.provider === provider);
    if (!conv || !conv.project) {
      muxyToast({ title: 'Copy failed', body: 'No project path', variant: 'error' });
      return;
    }
    const path = decodeClaudeProject(conv.project, state.home || '');
    let ok = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(path);
        ok = true;
      } catch (err) {
        console.warn('clipboard write failed', err);
      }
    }
    if (!ok) {
      const res = await copyLargeStringToClipboard(path);
      ok = res.ok;
    }
    if (ok) {
      muxyToast({ title: 'Path copied', body: path.slice(-60), variant: 'info' });
    } else {
      muxyToast({ title: 'Copy failed', body: 'Could not access clipboard', variant: 'error' });
    }
    return;
  }
  if (action === 'copy-md') {
    closeMenu();
    if (provider && id) await copyMarkdownFor(provider, id, file);
    return;
  }
  if (action === 'save-md') {
    closeMenu();
    if (provider && id) await openExportModal(provider, id, file);
    return;
  }
  if (action === 'rename') {
    closeMenu();
    if (card) startInlineRename(card);
    return;
  }
}

async function copyMarkdownFor(provider, id, file) {
  const conv = state.all.find((c) => c.id === id && c.provider === provider);
  if (!conv) return;
  let messages = [];
  try {
    if (provider === 'claude') messages = await readClaudeSessionMessages(file);
    else if (provider === 'opencode') messages = await readOpencodeMessages(id);
  } catch (e) {
    muxyToast({ title: 'Copy failed', body: e.message || String(e), variant: 'error' });
    return;
  }
  await copyMarkdownToClipboard(applyCustomTitle(conv, state.customTitles), messages);
}

// Open the export modal with a scrollable markdown preview. From here the user
// can Copy (clipboard) or Save (native browser Save As dialog → user-chosen path).
async function openExportModal(provider, id, file) {
  const conv = state.all.find((c) => c.id === id && c.provider === provider);
  if (!conv) {
    muxyToast({ title: 'Export failed', body: 'Conversation not found', variant: 'error' });
    return;
  }
  setStatus('Loading messages…', 'info');
  let messages = [];
  try {
    if (provider === 'claude') messages = await readClaudeSessionMessages(file);
    else if (provider === 'opencode') messages = await readOpencodeMessages(id);
  } catch (e) {
    muxyToast({ title: 'Export failed', body: e.message || String(e), variant: 'error' });
    setStatus('Export failed', 'error');
    return;
  }
  const titled = applyCustomTitle(conv, state.customTitles);
  const markdown = buildMarkdown(titled, messages);
  const filename = `${slugify(titled.title)}-${titled.id.slice(0, 8)}.md`;

  state.exportContext = { markdown, filename, provider, id, file };
  els.exportPreview.textContent = markdown;
  els.exportModal.classList.remove('hidden');
  setStatus(`${messages.length} messages ready to export`, 'ok');
  // Focus the preview so the user can immediately scroll/select text
  setTimeout(() => {
    if (els.exportPreview) els.exportPreview.focus();
  }, 0);
}

function closeExportModal() {
  els.exportModal.classList.add('hidden');
  state.exportContext = null;
}

// Triggers a browser "Save As" dialog via an in-memory Blob + <a download>.
// The user picks the destination and the OS file picker opens Finder under the hood.
function triggerMarkdownDownload(markdown, filename) {
  try {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) {
    console.warn('download trigger failed', e);
    return false;
  }
}

els.refresh.addEventListener('click', () => loadConversations());
els.search.addEventListener('input', (e) => {
  state.search = e.target.value;
  state.page = 1;
  renderList();
});
els.loadMore.addEventListener('click', () => {
  state.page += 1;
  renderList();
});
els.back.addEventListener('click', showList);
els.tabButtons.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabButtons.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.provider = tab.dataset.provider;
    state.page = 1;
    renderList();
  });
});
els.conversations.addEventListener('click', (e) => {
  const trigger = e.target.closest('.conv-menu-trigger');
  if (trigger) {
    e.stopPropagation();
    if (state.menuTargetId === trigger.dataset.menuId && !els.menuPopover.classList.contains('hidden')) {
      closeMenu();
    } else {
      openMenu(trigger);
    }
    return;
  }
  const card = e.target.closest('.conv');
  if (!card) return;
  if (card.querySelector('.conv-title-input')) return;
  const provider = card.dataset.provider;
  const id = card.dataset.id;
  const file = card.dataset.file || null;
  // Cmd/Ctrl+Click opens the detail view; plain click resumes in terminal
  if (e.metaKey || e.ctrlKey) {
    showDetail(provider, id, file);
  } else {
    openInTerminal(provider, id);
  }
});
els.menuPopover.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item') || e.target.closest('.back');
  if (!item) return;
  e.stopPropagation();
  handleMenuAction(item.dataset.action);
});
document.addEventListener('click', (e) => {
  if (!els.menuPopover.classList.contains('hidden')) {
    if (e.target.closest('.menu-popover') || e.target.closest('.conv-menu-trigger')) return;
    closeMenu();
  }
  // Export modal: clicking the backdrop or close button closes the modal
  if (!els.exportModal.classList.contains('hidden')) {
    if (e.target.closest('[data-export-close]')) {
      e.stopPropagation();
      closeExportModal();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.menuPopover.classList.contains('hidden')) {
      closeMenu();
    } else if (!els.exportModal.classList.contains('hidden')) {
      closeExportModal();
    }
  }
});

// Export modal buttons
els.exportCopy.addEventListener('click', async () => {
  const ctx = state.exportContext;
  if (!ctx) return;
  const conv = state.all.find((c) => c.id === ctx.id && c.provider === ctx.provider);
  if (!conv) return;
  // Reuse existing copy logic with the modal's already-loaded markdown to avoid
  // re-reading from disk
  let ok = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(ctx.markdown);
      ok = true;
    } catch (err) {
      console.warn('clipboard write failed', err);
    }
  }
  if (!ok) {
    const res = await copyLargeStringToClipboard(ctx.markdown);
    ok = res.ok;
  }
  if (ok) {
    muxyToast({ title: 'Copied', body: ctx.filename, variant: 'info' });
    setStatus('Copied markdown to clipboard', 'ok');
    closeExportModal();
  } else {
    muxyToast({ title: 'Copy failed', body: 'Could not access clipboard', variant: 'error' });
    setStatus('Copy failed', 'error');
  }
});

els.exportSave.addEventListener('click', () => {
  const ctx = state.exportContext;
  if (!ctx) return;
  const ok = triggerMarkdownDownload(ctx.markdown, ctx.filename);
  if (ok) {
    muxyToast({ title: 'Saving…', body: ctx.filename, variant: 'info' });
    setStatus(`Triggered download: ${ctx.filename}`, 'ok');
    closeExportModal();
  } else {
    muxyToast({ title: 'Save failed', body: 'Browser did not start the download', variant: 'error' });
    setStatus('Save failed', 'error');
  }
});

if (typeof muxy !== 'undefined' && muxy.events && muxy.events.subscribe) {
  try {
    muxy.events.subscribe('command.refresh-history', () => {
      loadConversations();
    });
  } catch (e) {
    console.warn('events.subscribe failed', e);
  }
}

// Project picker: button toggles popover
if (els.projectPicker) {
  els.projectPicker.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.pickerOpen) closeProjectPicker();
    else openProjectPicker();
  });
}

// Picker search: live filter
if (els.projectPickerSearch) {
  els.projectPickerSearch.addEventListener('input', (e) => {
    state.pickerQuery = e.target.value || '';
    renderPickerList();
  });
  els.projectPickerSearch.addEventListener('click', (e) => e.stopPropagation());
}

// Picker list: click selects
if (els.projectPickerList) {
  els.projectPickerList.addEventListener('click', (e) => {
    const btn = e.target.closest('.picker-item');
    if (!btn) return;
    const index = parseInt(btn.dataset.index, 10);
    if (Number.isNaN(index)) return;
    selectPickerItem(index);
  });
}

// Close picker on outside click
document.addEventListener('click', (e) => {
  if (!state.pickerOpen) return;
  if (!els.projectPickerPopover) return;
  if (e.target.closest('#project-picker-popover')) return;
  if (e.target.closest('#project-picker')) return;
  closeProjectPicker();
});

// Picker keyboard nav (Esc, ↑↓, Enter)
document.addEventListener('keydown', (e) => {
  if (!state.pickerOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeProjectPicker();
    if (els.projectPicker) els.projectPicker.focus();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = matchItem(state.pickerItems || [], 'down', state.pickerHighlight);
    if (next >= 0) {
      state.pickerHighlight = next;
      renderPickerList();
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = matchItem(state.pickerItems || [], 'up', state.pickerHighlight);
    if (prev >= 0) {
      state.pickerHighlight = prev;
      renderPickerList();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    selectPickerItem(state.pickerHighlight);
    return;
  }
});

// Global shortcut: Cmd+P / Ctrl+P opens picker
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    if (state.pickerOpen) closeProjectPicker();
    else openProjectPicker();
  }
});

// Breadcrumb click → filter by that path segment + auto-switch Muxy project
document.addEventListener('click', (e) => {
  const crumb = e.target.closest('.crumb');
  if (!crumb) return;
  const path = crumb.dataset.path || '';
  if (!path) return;
  // Fire-and-forget: helper applies the filter synchronously and performs
  // the best-effort auto-switch asynchronously.
  selectProjectAndFilter(path);
});

loadConversations();
