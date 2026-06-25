// Pure utility functions - testable in Node
// No DOM, no muxy API references

export function formatDate(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

export function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeSqlString(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

export function slugify(s) {
  return (
    String(s || 'untitled')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

export function displayProject(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

export function buildMarkdown(conv, messages) {
  const lines = [];
  const title = (conv.title || '(untitled)').replace(/\n/g, ' ').trim();
  lines.push(`# ${title}`, '');
  lines.push(`**Provider**: ${conv.provider === 'claude' ? 'Claude Code' : 'OpenCode'}`);
  if (conv.project) lines.push(`**Project**: ${conv.project}`);
  if (conv.firstTimestamp) lines.push(`**Created**: ${formatTimestamp(conv.firstTimestamp)}`);
  if (conv.lastTimestamp) lines.push(`**Updated**: ${formatTimestamp(conv.lastTimestamp)}`);
  lines.push(`**Session ID**: ${conv.id}`);
  lines.push(`**Messages**: ${messages.length}`, '');
  lines.push('---', '');
  for (const m of messages) {
    const role = (m.role || 'message').toUpperCase();
    const ts = m.timestamp ? ` · ${formatTimestamp(m.timestamp)}` : '';
    lines.push(`## ${role}${ts}`, '');
    lines.push(m.content || '', '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

export function buildRenameSql(id, newTitle) {
  return `UPDATE session SET title='${escapeSqlString(newTitle)}' WHERE id='${escapeSqlString(id)}';`;
}

export function applyCustomTitle(conv, customTitles) {
  if (!conv || !customTitles) return conv;
  const key = `${conv.provider}:${conv.id}`;
  const custom = customTitles[key];
  if (custom) return { ...conv, title: custom };
  return conv;
}

export function getVisibleConversations(all, { provider = 'all', projectFilter = '', search = '' } = {}) {
  let list = all;
  if (provider !== 'all') {
    list = list.filter((c) => c.provider === provider);
  }
  if (projectFilter) {
    list = list.filter((c) => projectMatchesFilter(c.project, projectFilter));
  }
  if (search.trim()) {
    const q = search.toLowerCase();
    list = list.filter(
      (c) =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.preview || '').toLowerCase().includes(q) ||
        (c.project || '').toLowerCase().includes(q)
    );
  }
  return list.slice().sort((a, b) => {
    const ta = a.lastTimestamp || '';
    const tb = b.lastTimestamp || '';
    return tb.localeCompare(ta);
  });
}

// Returns true if a conversation's project matches the dropdown filter.
// - Decodes Claude's encoded form first
// - Supports subpath match: if filter is a git toplevel, matches all subdirs
export function projectMatchesFilter(cProject, filterValue) {
  if (!filterValue) return true;
  const decoded = decodeClaudeProject(cProject);
  if (!decoded) return false;
  if (decoded === filterValue) return true;
  if (decoded.startsWith(filterValue + '/')) return true;
  return false;
}

export function paginate(list, page, pageSize) {
  const limit = Math.min(list.length, page * pageSize);
  return {
    items: list.slice(0, limit),
    hasMore: limit < list.length,
    remaining: Math.max(0, list.length - limit)
  };
}

export function uniqueProjects(list) {
  const set = new Set();
  for (const c of list) {
    if (c.project) set.add(c.project);
  }
  return Array.from(set).sort();
}

// Decodes a Claude Code project dir back to a real filesystem path.
// Claude encodes "/Users/x/Repos/ac" as "-Users-x-Repos-ac".
// Returns the same string for absolute paths that don't look encoded.
export function decodeClaudeProject(project) {
  if (!project) return '';
  // Already an absolute path
  if (project.startsWith('/')) return project;
  // Encoded form starts with '-' (the encoded form of the leading '/')
  if (project.startsWith('-')) {
    return '/' + project.slice(1).replace(/-/g, '/');
  }
  // Fallback: just return as-is
  return project;
}

// Extracts a displayable repo label from a project string.
// If gitToplevelMap has a toplevel for the decoded path (or any parent
// directory), returns the basename of the toplevel and isGit=true. Otherwise
// returns the decoded full path and isGit=false.
export function extractRepoLabel(project, gitToplevelMap = {}) {
  const decoded = decodeClaudeProject(project);
  if (!decoded) return { label: '', isGit: false, toplevel: null, displayPath: '' };
  // Walk up the path looking for a toplevel match (handles subdirs of git repos
  // whose own path isn't in the map but whose parent is).
  let current = decoded;
  while (current && current !== '/') {
    const toplevel = gitToplevelMap[current];
    if (toplevel) {
      const parts = toplevel.split('/').filter(Boolean);
      return {
        label: parts.length > 0 ? parts[parts.length - 1] : toplevel,
        isGit: true,
        toplevel,
        displayPath: decoded
      };
    }
    const parent = current.replace(/\/[^/]+$/, '');
    if (parent === current) break;
    current = parent;
  }
  return { label: decoded, isGit: false, toplevel: null, displayPath: decoded };
}

// Builds the CLI command to resume a session in its native provider CLI.
export function buildResumeCommand(provider, id) {
  if (provider === 'claude') return `claude --resume ${id}`;
  if (provider === 'opencode') return `opencode -s ${id}`;
  return null;
}

// Groups unique project strings into {git:[], nonGit:[]} with their labels.
// Dedupes the git group by toplevel (Claude and OpenCode may both refer to the
// same repo with different raw project values). The git entry's `value`
// (== `project` field) is the toplevel so projectMatchesFilter can match
// subpath sessions in the same repo.
export function projectDisplayGroups(projects, gitToplevelMap = {}) {
  const gitByToplevel = new Map();
  const nonGitByPath = new Map();
  for (const project of projects) {
    const info = extractRepoLabel(project, gitToplevelMap);
    if (info.isGit) {
      const key = info.toplevel;
      if (!gitByToplevel.has(key)) {
        gitByToplevel.set(key, {
          project: info.toplevel,
          label: info.label,
          isGit: true,
          toplevel: info.toplevel,
          displayPath: info.displayPath
        });
      }
    } else {
      const key = info.displayPath || project;
      if (!nonGitByPath.has(key)) {
        nonGitByPath.set(key, {
          project,
          label: info.label,
          isGit: false,
          toplevel: null,
          displayPath: info.displayPath
        });
      }
    }
  }
  const git = Array.from(gitByToplevel.values()).sort((a, b) => a.label.localeCompare(b.label));
  const nonGit = Array.from(nonGitByPath.values()).sort((a, b) => a.label.localeCompare(b.label));
  return { git, nonGit };
}

// Splits a string into chunks of at most `size` characters.
// Used by the chunked base64 writer so each muxy.exec call stays under ARG_MAX.
export function chunkString(s, size) {
  if (!s) return [];
  if (size <= 0) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size));
  }
  return out;
}

// Returns true if `child` is the same path as `parent` or a nested entry inside
// it. Strict prefix match (uses '/' separator) so /foo/barx doesn't match /foo/bar.
// Empty / non-string inputs return false.
export function pathInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false;
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent + '/');
}

// Picks the project entry (from muxy.projects.list()) whose path is the most
// specific ancestor of `targetPath`. Projects with the longest matching path
// win. Returns null if no project contains `targetPath`.
//
// `projects` may have any of these path fields (we try them in order):
//   - path
//   - root
//   - directory
//   - worktree
//
// This is a pure helper so it can be unit-tested without a Muxy environment.
export function findBestProjectForPath(projects, targetPath) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (!targetPath || typeof targetPath !== 'string') return null;
  let best = null;
  for (const p of projects) {
    if (!p || typeof p !== 'object') continue;
    const pPath = p.path || p.root || p.directory || p.worktree;
    if (typeof pPath !== 'string' || !pPath) continue;
    if (pathInside(targetPath, pPath)) {
      if (!best || pPath.length > best.path.length) {
        best = { ...p, path: pPath };
      }
    }
  }
  return best;
}

// Picks the worktree entry (from muxy.worktrees.list() or muxy.git.worktrees())
// whose path is the most specific ancestor of `targetPath`. Longest matching
// path wins. Returns null if no worktree contains the path.
//
// `worktrees` items may use any of these path fields (we try them in order):
//   - path
//   - root
//   - directory
export function findBestWorktreeForPath(worktrees, targetPath) {
  if (!Array.isArray(worktrees) || worktrees.length === 0) return null;
  if (!targetPath || typeof targetPath !== 'string') return null;
  let best = null;
  for (const w of worktrees) {
    if (!w || typeof w !== 'object') continue;
    const wPath = w.path || w.root || w.directory;
    if (typeof wPath !== 'string' || !wPath) continue;
    if (pathInside(targetPath, wPath)) {
      if (!best || wPath.length > best.path.length) {
        best = { ...w, path: wPath };
      }
    }
  }
  return best;
}

// Returns true if the worktree is the currently active one.
// Prefers the explicit `isActive` / `active` field, then a path match against
// `activePath` (e.g. muxy.git.repoInfo().root for the active worktree).
export function isWorktreeActive(worktree, activePath) {
  if (!worktree) return false;
  if (worktree.isActive === true) return true;
  if (worktree.isActive === false) return false;
  if (worktree.active === true) return true;
  if (worktree.active === false) return false;
  if (typeof activePath === 'string' && activePath) {
    return pathInside(activePath, worktree.path || worktree.root || worktree.directory);
  }
  return false;
}
