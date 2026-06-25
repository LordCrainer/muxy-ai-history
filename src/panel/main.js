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
  isWorktreeActive
} from './utils.js';
import { openInTerminal as openInTerminalImpl } from './open-in-terminal.js';

const HOME = (typeof process !== 'undefined' && process.env && process.env.HOME) || '';
const CLAUDE_PROJECTS = `${HOME}/.claude/projects`;
const OPENCODE_DB = `${HOME}/.local/share/opencode/opencode.db`;
const SIDECAR_PATH = `${HOME}/.config/muxy/extensions/ai-history/custom-titles.json`;
const EXPORT_DIR = `${HOME}/Downloads/ai-history`;
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
  currentDetail: null,
  menuTargetId: null,
  menuView: 'main',
  menuAnchor: null,
  exportContext: null
};

const els = {
  refresh: document.getElementById('refresh'),
  search: document.getElementById('search'),
  projectFilter: document.getElementById('project-filter'),
  status: document.getElementById('status'),
  conversations: document.getElementById('conversations'),
  loadMoreWrap: document.getElementById('load-more-wrap'),
  loadMore: document.getElementById('load-more'),
  detail: document.getElementById('detail'),
  back: document.getElementById('back'),
  detailTitle: document.getElementById('detail-title'),
  detailMeta: document.getElementById('detail-meta'),
  messages: document.getElementById('messages'),
  tabs: document.querySelectorAll('.tab'),
  menuPopover: document.getElementById('menu-popover'),
  exportModal: document.getElementById('export-modal'),
  exportPreview: document.getElementById('export-modal-preview'),
  exportCopy: document.getElementById('export-modal-copy'),
  exportSave: document.getElementById('export-modal-save')
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

function populateProjectFilter() {
  const projects = uniqueProjects(state.all);
  const current = state.projectFilter;
  const groups = projectDisplayGroups(projects, state.gitToplevelMap);
  let html = '<option value="">All projects</option>';
  if (groups.git.length > 0) {
    html += '<optgroup label="Git repos">';
    for (const g of groups.git) {
      html += `<option value="${escapeHtml(g.project)}" title="${escapeHtml(g.displayPath)}">${escapeHtml(g.label)}</option>`;
    }
    html += '</optgroup>';
  }
  if (groups.nonGit.length > 0) {
    html += '<optgroup label="Other paths">';
    for (const g of groups.nonGit) {
      const label = g.label.length > 60 ? '…' + g.label.slice(-58) : g.label;
      html += `<option value="${escapeHtml(g.project)}" title="${escapeHtml(g.displayPath)}">${escapeHtml(label)}</option>`;
    }
    html += '</optgroup>';
  }
  els.projectFilter.innerHTML = html;
  if (current) {
    // Restore selection if the value still exists (raw value or toplevel)
    const match = els.projectFilter.querySelector(`option[value="${CSS.escape(current)}"]`);
    if (match) els.projectFilter.value = current;
  }
}

async function gitToplevel(path) {
  const res = await muxyExec('/usr/bin/git', ['-C', path, 'rev-parse', '--show-toplevel'], { timeoutMs: 4e3 });
  if (res.exitCode !== 0) return null;
  const t = (res.stdout || '').trim();
  return t || null;
}

async function loadProjectLabels() {
  const projects = uniqueProjects(state.all);
  const decodedPaths = new Set();
  for (const p of projects) {
    const decoded = decodeClaudeProject(p);
    if (decoded) decodedPaths.add(decoded);
  }
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
}

function renderList() {
  const visibleAll = getVisibleConversations(state.all, {
    provider: state.provider,
    projectFilter: state.projectFilter,
    search: state.search
  }).map((c) => applyCustomTitle(c, state.customTitles));
  populateProjectFilter();
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
  const { items, hasMore, remaining } = paginate(visibleAll, state.page, state.pageSize);
  els.conversations.innerHTML = items
    .map(
      (c) => `
      <div class="conv" data-provider="${c.provider}" data-id="${escapeHtml(c.id)}" data-file="${escapeHtml(c.file || '')}">
        <button class="conv-menu-trigger" type="button" aria-label="Menu" data-menu-id="${escapeHtml(c.id)}">⋮</button>
        <div class="conv-header">
          <span class="conv-provider ${c.provider}">${c.provider === 'claude' ? 'C' : 'OC'}</span>
          <span class="conv-title">${escapeHtml(c.title || '(untitled)')}</span>
        </div>
        <div class="conv-meta">
          <span class="conv-project" title="${escapeHtml(c.project || '')}">${escapeHtml(displayProject(c.project))}</span>
          <span class="conv-time">${escapeHtml(formatDate(c.lastTimestamp))}</span>
        </div>
        <div class="conv-preview">${escapeHtml(c.preview || '')}</div>
      </div>
    `
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
  const sql = `SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 500`;
  const result = await muxyExec('/usr/bin/sqlite3', ['-json', OPENCODE_DB, sql], { timeoutMs: 15e3 });
  if (result.exitCode !== 0) return [];
  const text = (result.stdout || '').trim();
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    return rows.map((r) => ({
      provider: 'opencode',
      id: r.id,
      project: r.directory || '',
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
    state.customTitles = await loadCustomTitles();
    const [claude, opencode] = await Promise.all([
      listClaudeConversations().catch((e) => { console.warn('claude list error', e); return []; }),
      readOpencodeSessions().catch((e) => { console.warn('opencode list error', e); return []; })
    ]);
    state.all = [
      ...claude.map((c) => ({ ...c, provider: 'claude' })),
      ...opencode.map((c) => ({ ...c, provider: 'opencode' }))
    ];
    await loadProjectLabels();
    const total = state.all.length;
    if (total === 0) {
      setStatus('No conversations found. Check that Claude Code or OpenCode are installed.', 'warn');
    } else {
      setStatus(`${total} conversation${total === 1 ? '' : 's'} (${claude.length} Claude · ${opencode.length} OpenCode)`, 'ok');
    }
    renderList();
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
  document.querySelector('.filters').classList.add('hidden');
  document.querySelector('.tabs').classList.add('hidden');
  els.detail.classList.remove('hidden');
  els.detailTitle.textContent = (conv && conv.title) || '(untitled)';
  const meta = [];
  if (conv) {
    if (conv.project) meta.push(conv.project);
    if (conv.lastTimestamp) meta.push(formatDate(conv.lastTimestamp));
  }
  meta.push(`${messages.length} message${messages.length === 1 ? '' : 's'}`);
  els.detailMeta.textContent = meta.join(' · ');
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
  document.querySelector('.filters').classList.remove('hidden');
  document.querySelector('.tabs').classList.remove('hidden');
  renderList();
}

async function exportConversation(provider, id, file) {
  const visible = getVisibleConversations(state.all, {
    provider: state.provider,
    projectFilter: state.projectFilter,
    search: state.search
  }).map((c) => applyCustomTitle(c, state.customTitles));
  const conv = visible.find((c) => c.id === id && c.provider === provider) ||
    state.all.find((c) => c.id === id && c.provider === provider);
  if (!conv) {
    muxyToast({ title: 'Export failed', body: 'Conversation not found', variant: 'error' });
    return;
  }
  setStatus('Exporting...', 'info');
  let messages = [];
  try {
    if (provider === 'claude') {
      messages = await readClaudeSessionMessages(file);
    } else if (provider === 'opencode') {
      messages = await readOpencodeMessages(id);
    }
  } catch (e) {
    muxyToast({ title: 'Export failed', body: e.message || String(e), variant: 'error' });
    setStatus('Export failed', 'error');
    return;
  }
  const markdown = buildMarkdown(conv, messages);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filename = `${slugify(conv.title)}-${conv.id.slice(0, 8)}-${stamp}.md`;
  const fullPath = `${EXPORT_DIR}/${filename}`;

  const result = await writeLargeStringToFile(fullPath, markdown, {
    onProgress: (i, total) => setStatus(`Exporting... (chunk ${i}/${total})`, 'info')
  });
  if (!result.ok) {
    muxyToast({ title: 'Export failed', body: result.error || 'write error', variant: 'error' });
    setStatus('Export failed', 'error');
    return;
  }

  muxyToast({ title: 'Exported', body: filename, variant: 'info' });
  setStatus(`Exported to ${fullPath} (${result.chunks} chunk${result.chunks === 1 ? '' : 's'})`, 'ok');
  if (typeof muxy !== 'undefined' && muxy.exec) {
    try { muxy.exec(['/usr/bin/open', '-R', fullPath]); } catch {}
  }
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
      <button class="menu-item" data-action="open-terminal" type="button">Open in Terminal</button>
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
  if (action === 'open-terminal') {
    closeMenu();
    if (provider && id) await openInTerminal(provider, id);
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
els.projectFilter.addEventListener('change', (e) => {
  state.projectFilter = e.target.value;
  state.page = 1;
  renderList();
});
els.loadMore.addEventListener('click', () => {
  state.page += 1;
  renderList();
});
els.back.addEventListener('click', showList);
els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.remove('active'));
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
  showDetail(provider, id, file);
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

loadConversations();
