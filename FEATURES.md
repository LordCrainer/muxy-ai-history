# AI History — Features

Spec completa de la extension `ai-history` para Muxy. Mantener sincronizado con el `README.md` en cada release.

## Resumen

Lista unificada de conversaciones de **Claude Code** y **OpenCode** dentro de Muxy, con menu de acciones por conversacion (ver detalle, abrir terminal, exportar, renombrar).

## Fuentes de datos

| Provider | Storage | Schema |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/<session-id>.jsonl` | JSONL, una linea por mensaje |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) | `session`, `message`, `part` (text/tool/reasoning) |

Claude codifica los paths como `-Users-x-Repos-ac`. La extension los decodea de vuelta a `/Users/x/Repos/ac`.

## UI

### Lista principal
- **Tabs** All / Claude / OpenCode
- **Search** en tiempo real (titulo + preview + project)
- **Project filter** agrupado:
  - `Git repos` (optgroup arriba): basename del toplevel
  - `Other paths` (optgroup abajo): ruta completa dedupeada
  - **Subpath match**: si filtras por el toplevel, incluye subdirs del mismo repo
- **Paginacion** con "Load more (N remaining)" — 50 por pagina
- **Refresh button** en el topbar
- **Status bar** debajo de los filtros con conteos y mensajes

### Card de conversacion
- Provider badge (C / OC) en color
- Titulo (con custom title override si existe)
- Project path corto (`displayProject`: …/last-2-segments para paths largos)
- Timestamp relativo (just now / 5m ago / 2d ago / fecha)
- Preview del primer mensaje
- Trigger 3-dot (⋮) a la derecha

### Menu 3-dot

| Accion | Comportamiento |
|---|---|
| **View** | Abre la vista de detalle (lista de mensajes con render de code/bold/italic) |
| **Open in Terminal** | v0.6: smart routing — project + worktree + tab reuse (ver detalle abajo) |
| **Export ▶** | Submenu: |
| &nbsp;&nbsp;↳ Copy to Clipboard | Clipboard API + fallback `pbcopy` |
| &nbsp;&nbsp;↳ Save as Markdown… | Modal con preview + native OS file picker |
| **Rename** | Inline edit; OpenCode = SQL UPDATE, Claude = sidecar JSON |

### Vista de detalle
- Boton Back
- Meta: provider, project, last update, message count
- Mensajes con role + timestamp + content
- Render basico: code blocks, inline code, bold, italic

### Modal de export
- Centrado con backdrop
- Preview markdown scrolleable (max-height 500px, monospace)
- Boton Copy (clipboard)
- Boton Save (browser-native `Blob` + `<a download>` → Finder file picker)
- Cerrar con × / Esc / click backdrop

## Open in Terminal (v0.6 — refined flow)

Flujo inteligente que **verifica si el proyecto ya está abierto** antes de abrir uno nuevo:

```
1. decodeClaudeProject(conv.project) → projectDir (path absoluto)

2. tabs.list() → busca terminal ya en projectDir (o subdirectorio)
   ├─ found: switchTo(tab) + return ("Project already open")

3. projects.list() → findBestProjectForPath(projects, projectDir)
   ├─ no match: tabs.open({kind: 'terminal', command}) → "New workspace (project not in Muxy)"

4. match found → projects.switchTo(match) (si no está activo)

5. worktrees.list({project}) || git.worktrees({project}) →
   findBestWorktreeForPath(worktrees, projectDir)
   ├─ match && !isActive: worktrees.switchTo(match.name || match.branch)
   │  └─ tabs.open({kind: 'terminal', command, directory: projectDir})
   ├─ no match: tabs.open({kind: 'terminal', command, directory: projectDir}) → "New workspace (no matching worktree)"
```

**Command wrapping**: el resume command (`claude --resume <id>` o `opencode -s <id>`) se envuelve con `cd "<projectDir>" && <cmd>` usando `\\` `\"` `\$` \`` `` escaping. Garantiza cwd correcto incluso si Muxy ignora `directory`.

**Nuevo workspace**: si el proyecto no está en Muxy o no hay worktree match, abre un nuevo workspace con el comando wraped. Toast informativo indica el contexto.

### v0.6.2 — Permission fix + refactor

User reportó que "Open in Terminal" no switchaba el Muxy project/worktree. El log de v0.6.1 mostró que el flujo caía en `step=3b` (project NOT in Muxy) sin haber chequeado projects list. Root cause: **faltaban los permisos `:read`**.

Muxy distingue `read` y `write` como permisos separados. El manifest tenía `tabs:write` y `projects:write` (para `open()` y `switchTo()`), pero faltaban `tabs:read` y `projects:read` (para `list()`). El código llamaba `muxy.tabs.list()` y `muxy.projects.list()` que devolvían `permission denied`, el flujo se caía al branch de "no match" y abría una terminal con `cd <dir>` wrapping sin switchear nada.

**Fix**: agregar `tabs:read` y `projects:read` al manifest (total 8 permisos).

**Refactor menor**: `openInTerminal` se extrajo de `main.js` a `src/panel/open-in-terminal.js` con deps inyectadas (`muxy`, `toast`, `setStatus`, `state`, `log`, helpers). El wrapper en `main.js` pasa el `muxy` real; los tests inyectan mocks. Permite los 72 tests en `tests/test-open-in-terminal.mjs` que cubren los CA A-L sin tocar Muxy.

**Bugfix pre-existente**: el pre-check log de API availability crasheaba con `TypeError` si `muxy.git.worktree` era undefined (usaba `typeof x && typeof x.y` que no short-circuita porque `typeof undefined` es la string `"undefined"`, truthy). Cambiado a `typeof x?.y`.

## Permisos del manifest

| Permiso | Por que |
|---|---|
| `panels:write` | Render del panel UI |
| `notifications:write` | Toasts (informacion de acciones) |
| `tabs:read` | `tabs.list()` para detectar tab existente en el directorio (v0.6) |
| `tabs:write` | `tabs.open` + `tabs.switchTo` para Open in Terminal |
| `git:read` | `git.repoInfo()` para detectar active worktree; `git.worktrees()` como fallback de worktree list |
| `projects:read` | `projects.list()` para verificar si el directorio es un Muxy project (v0.5) |
| `projects:write` | `projects.switchTo()` para project switching |
| `commands:exec` | `muxy.exec` para cat/sqlite3/mkdir/printf/base64/pbcopy/git |

## Custom titles storage

| Provider | Storage | Formato |
|---|---|---|
| OpenCode | SQLite `session.title` (direct UPDATE) | Persiste, visible en otros clients |
| Claude Code | sidecar JSON | `~/.config/muxy/extensions/ai-history/custom-titles.json` |

Sidecar se usa porque Claude Code no tiene campo title editable. Formato: `{"claude:<session-id>": "new title"}`. Si se borra el sidecar, los titulos vuelven a los originales.

## Comandos del manifest

| ID | Title | Shortcut | Action |
|---|---|---|---|
| `toggle-history` | Toggle AI History | `Cmd+Shift+H` | `togglePanel` `history` |
| `refresh-history` | Refresh AI History | (palette only) | Recarga conversaciones |

## Topbar item

Icono `clock.arrow.circlepath` (SF Symbol). Click → `toggle-history`. Visible en el topbar principal.

## Atajos de teclado

- `Cmd+Shift+H` — toggle del panel
- `Esc` — cerrar menu 3-dot / modal de export / cancelar rename
- `Enter` en input de rename — guardar
- `Cmd+R` (built-in Muxy) — reload de la extension

## Formato de export

Markdown con frontmatter-like header:

```markdown
# <Title>

**Provider**: Claude Code | OpenCode
**Project**: /Users/x/Repos/foo
**Created**: <iso timestamp>
**Updated**: <iso timestamp>
**Session ID**: <id>
**Messages**: <count>

---

## USER · <timestamp>

<content>

---

## ASSISTANT · <timestamp>

<content>

---
```

## Chunked base64 writer (v0.3.1+)

Para escribir contenido grande (exports, sidecar) evitando ARG_MAX y heredoc hangs:

1. `base64Encode(content)` (browser `btoa` con `unescape(encodeURIComponent(s))`)
2. Split en chunks de 60KB → `chunkString(b64, 60*1024)`
3. Cada chunk: `muxy.exec(["/bin/sh", "-c", "printf '%s' '<chunk>' >> /tmp/ai-history-write.b64"])`
4. Final: `muxy.exec(["/bin/sh", "-c", "base64 -d < /tmp/ai-history-write.b64 > PATH && rm -f /tmp/ai-history-write.b64"])`

**Por que 60KB**: ARG_MAX de sh=262KB, kern=1MB. 60KB da margen amplio para que cada exec se mantenga bajo el limite.

**Consent prompts**: cada `muxy.exec` puede mostrar "Allow this command to run?" la primera vez. Aceptar "Allow & remember" para que no repita.

## API usada (window.muxy)

```js
// I/O de archivos y shell
muxy.exec(["/bin/cat", file])                                          // read
muxy.exec(["/usr/bin/sqlite3", "-json", db, sql])                      // query
muxy.exec(["/usr/bin/sqlite3", db, updateSql])                          // update
muxy.exec(["/bin/mkdir", "-p", dir])                                   // mkdir
muxy.exec({ shell: "printf '%s' '...' >> /tmp/..." })                  // chunked write
muxy.exec({ shell: "base64 -d < /tmp/... > PATH" })                    // decode + write
muxy.exec(["/usr/bin/open", "-R", path])                               // reveal in Finder

// Projects
muxy.projects.list()
muxy.projects.switchTo(identifier)        // name | id | path

// Worktrees (v0.6)
muxy.worktrees.list({project?})           // app-level
muxy.worktrees.switchTo(identifier, project?)
muxy.git.worktrees()                       // fallback (git-level)
muxy.git.worktree.switchTo({identifier})   // fallback

// Git
muxy.git.repoInfo()                        // {root, gitDir, isWorktree, currentBranch}

// Tabs
muxy.tabs.list()                           // TabInfo[]
muxy.tabs.switchTo(idOrIndex)
muxy.tabs.open({kind, command, directory, singleton})

// UI
muxy.toast({title, body, variant})         // variant: 'info' | 'error' | 'success' | 'warn'
muxy.events.subscribe('command.refresh-history', () => loadConversations())

// Browser
navigator.clipboard.writeText(markdown)     // clipboard (fallback a pbcopy)
```

## Troubleshooting

| Issue | Causa probable | Fix |
|---|---|---|
| "permission denied (git:read)" | manifest sin `git:read` | Reload extension despues de editar manifest |
| "permission denied (tabs:read)" o "permission denied (projects:read)" | manifest sin los :read (v0.6.2 fix) | Agregar `tabs:read` y `projects:read` al array de permissions, reload, aceptar consent prompt |
| "directory must be an existing folder inside the worktree" | projectDir no es child del active worktree | v0.6 switch automatico al worktree correcto; si falla, hace fallback |
| "Allow this command to run?" cada vez | no marcaste "Allow & remember" | Click "Allow & remember" en el primer prompt |
| OpenCode rename no persiste | sidecar no se usa para OpenCode (es SQL directo) | n/a — el UPDATE es directo |
| Custom title no aparece en Claude | sidecar corrupto o no leido | Verificar `~/.config/muxy/extensions/ai-history/custom-titles.json` |
| Tabla duplicada en dropdown de projects | dos project strings apuntan al mismo toplevel | v0.5 deduplica por toplevel + walk-up parents |
| "Open in Terminal" abre sin switchear project/worktree | Falta `tabs:read` o `projects:read` en manifest | v0.6.2 fix; verificar el log con `grep "\[openInTerminal\]"` para ver el step exacto que falla |

## Tests

Tres suites, 499 tests total (correr con `npm test`):

| Suite | Tests | Que cubre |
|---|---|---|
| `tests/test-parsers.mjs` | 407 | Smoke tests: parse JSONL, SQLite queries, manifest permissions, API patterns en source y bundle, v0.6.1 logging call sites (olog(0,...) etc.) |
| `tests/test-chunked-write.mjs` | 20 | Round-trip del chunked base64 writer (1KB a 1MB, Unicode, shell-special chars, markdown) |
| `tests/test-open-in-terminal.mjs` | 72 | 12 acceptance criteria A-L de `openInTerminal` con mocks de la Muxy API; 4 shell escape; 4 manifest permissions |

**Mock factory** (`createMuxyMock()`): programmable mock que registra cada call site y permite inyectar respuestas por key (e.g. `muxy.set('git.repoInfo', {root: '/path'})` o `muxy.on('tabs.open', () => { throw ... })`). Tests no requieren un host Muxy real.

**El test CA F es el más importante**: verifica que cuando el worktree NO está activo, `muxy.worktrees.switchTo` se llama con args posicionales `[name, projectId]`, que `git.repoInfo` se llama ≥2 veces (initial + verify pass), y que el log contiene `"switch VERIFIED"`. Este test habría detectado el bug de permisos (las calls no se hubieran hecho por el throw) o el bug de arg shape (positional vs object).

## Bundle size

~35KB raw / ~11KB gzipped. Solo Vite + vanilla JS. No frameworks.
