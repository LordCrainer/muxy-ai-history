# AI History - Muxy Extension

Visualiza el historial de conversaciones de **Claude Code** y **OpenCode** dentro de Muxy.

> 📋 Para la spec completa (todos los helpers, formatos, troubleshooting, API detallada): **[FEATURES.md](./FEATURES.md)**

## Características

- **Lista unificada** de conversaciones de Claude Code y OpenCode
- **Filtros** por proveedor (All / Claude / OpenCode) y por proyecto
- **Dropdown de proyectos** agrupado:
  - `Git repos` (arriba): basename del toplevel (e.g. `muxy-extensions`)
  - `Other paths` (abajo): ruta completa, dedupeada
  - Subpath match: si tu proyecto está en un subdir de un repo git, el filtro del repo raíz lo incluye
- **Búsqueda** en tiempo real por título, contenido y proyecto
- **Paginación** con botón "Load more" (50 por página)
- **Vista de detalle** con todos los mensajes de la conversación
- **Renderizado** de código, negrita, itálica
- **Menú 3-dot** por conversación con submenú Export:
  - **View** — abre la vista de detalle
  - **Open in Terminal** (v0.6) — smart routing:
    1. Switch al Muxy project que contiene la conversación
    2. Switch al Muxy worktree que contiene la conversación
    3. Reusa una terminal tab existente si ya apunta al directorio
    4. Abre nueva terminal con `claude --resume <id>` / `opencode -s <id>` y `cd <dir>` wrapping
    5. Fallback al cwd default si Muxy rechaza `directory`
  - **Export ▶** — submenú con:
    - **Copy to Clipboard** — copia al portapapeles (Clipboard API, fallback a `pbcopy`)
    - **Save as Markdown…** — abre un modal centrado con preview del markdown (max 500px + scroll) y botón Save… que dispara el download nativo del browser → file picker del OS
  - **Rename** — inline edit; para OpenCode actualiza SQLite, para Claude usa sidecar JSON
- **Atajo de teclado**: `Cmd+Shift+H` para abrir/cerrar el panel
- **Icono en topbar** para acceso rápido

## Estructura

```
ai-history/
├── package.json              # Manifest de Muxy
├── vite.config.js            # Build config con plugin fixup-output
├── src/
│   ├── panel/
│   │   ├── panel.html        # Entry HTML
│   │   ├── main.js           # UI logic + I/O via muxy.exec
│   │   ├── utils.js          # Funciones puras (format, escape, paginate, etc.)
│   │   └── styles.css        # Estilos dark theme
│   └── assets/
│       └── icon.svg
├── tests/
│   ├── test-parsers.mjs          # 407 smoke tests
│   ├── test-chunked-write.mjs    # 20 integration tests (round-trip base64)
│   └── test-open-in-terminal.mjs # 72 tests (12 CA A-L + 4 shell escape + 4 manifest)
└── dist/                     # Output del build
    ├── panel.html
    ├── package.json
    ├── icon.svg
    └── assets/
        ├── panel-*.js
        └── panel-*.css
```

## Fuentes de datos

- **Claude Code**: `~/.claude/projects/<encoded-path>/<session-id>.jsonl` (JSONL, una línea por mensaje)
- **OpenCode**: `~/.local/share/opencode/opencode.db` (SQLite)
  - `session` table: `id, title, directory, time_created, time_updated, ...`
  - `message` + `part` tables: mensajes con parts de tipo text/tool/reasoning

## Custom titles storage

- **OpenCode**: modifica directamente `session.title` en SQLite. Persiste, visible en otros clients.
- **Claude Code**: sidecar JSON porque Claude no tiene campo title editable.
  - Path: `~/.config/muxy/extensions/ai-history/custom-titles.json`
  - Formato: `{"claude:<session-id>": "new title"}`

## API usada (muxy directo desde panel)

- `muxy.exec(["/bin/cat", file])` — leer JSONL / sidecar
- `muxy.exec(["/usr/bin/sqlite3", "-json", db, sql])` — query OpenCode
- `muxy.exec(["/usr/bin/sqlite3", db, updateSql])` — rename OpenCode
- `muxy.exec(["/bin/mkdir", "-p", dir])` — crear export dir
- `muxy.exec(["/bin/sh", "-c", "printf '%s' '...' >> /tmp/..."])` — chunked base64 writes
- `muxy.exec(["/bin/sh", "-c", "base64 -d < /tmp/... > PATH"])` — decode + write final
- `muxy.exec(["/usr/bin/open", "-R", path])` — reveal en Finder
- `muxy.git.repoInfo()` — validar que el proyecto está dentro del worktree activo antes de `tabs.open`
- `muxy.tabs.list()` / `muxy.tabs.switchTo(id)` / `muxy.tabs.open({kind, command, directory})` — abrir o reusar terminal
- `muxy.toast({title, body, variant})` — notificaciones
- `muxy.events.subscribe('command.refresh-history', ...)` — refresh desde menú
- `navigator.clipboard.writeText(markdown)` — Copy as Markdown (fallback a `pbcopy` chunked)

## Permisos del manifest

```json
"permissions": [
  "panels:write",        // panel UI
  "notifications:write", // toasts
  "tabs:write",          // abrir terminal tabs (Open in Terminal)
  "git:read",            // muxy.git.repoInfo() para inferir active project (fallback)
  "projects:write",      // muxy.projects.list() + switchTo() para abrir en el cwd correcto
  "commands:exec"        // muxy.exec shell (cat, sqlite3, mkdir, printf, base64, pbcopy, git, etc.)
]
```

## Notas sobre consent prompts

Cada llamada a `muxy.exec` puede mostrar un diálogo **"Allow this command to run?"** la primera vez que se invoca. Para minimizar prompts:

- **Haz click en "Allow & remember"** la primera vez que exportes / copies una conversación. Muxy recordará ese patrón de comando y no volverá a preguntar.
- El writer chunked (v0.3.1) emite varios `printf '%s' '...' >> tmp` consecutivos. Si bien cada chunk es un comando distinto, todos comparten la misma forma; aceptando "Allow & remember" en el primero, el resto suele pasar sin prompt adicional.
- Si el diálogo se vuelve molesto, podés revocar permisos en Settings → Extensions → AI History → Reset consent.

## v0.6.2 — Permission fix + mini-refactor

User reportó que "Open in Terminal" no switchaba el Muxy project/worktree (solo abría terminal con `cd <dir>` wrapping). El log de v0.6.1 reveló el bug en el primer run: **faltaban los permisos `:read` en el manifest**.

**Causa raíz**: Muxy distingue `read` y `write` como permisos separados. El manifest tenía `tabs:write` y `projects:write` (para `open()` y `switchTo()`), pero faltaban `tabs:read` y `projects:read` (para `list()`). El código llamaba `muxy.tabs.list()` y `muxy.projects.list()` que devolvían `permission denied (tabs:read)` / `(projects:read)`. El flujo caía al branch de "no match" y abría una terminal sin switchear nada.

**Fix** (2 líneas en `package.json`):

```diff
   "permissions": [
     "panels:write",
     "notifications:write",
+    "tabs:read",
     "tabs:write",
     "git:read",
+    "projects:read",
     "projects:write",
     "commands:exec"
   ],
```

**Refactor menor**: `openInTerminal` se extrajo de `main.js` a `src/panel/open-in-terminal.js` con deps inyectadas (`muxy`, `toast`, `setStatus`, `state`, `log`, helpers). El wrapper en `main.js` pasa el `muxy` real; los tests inyectan mocks. Esto habilita los 12 tests CA A-L sin tocar Muxy.

**Bugfix pre-existente** (expuesto por los tests): el pre-check log de API availability crasheaba con `TypeError` si `muxy.git.worktree` era undefined (usaba `typeof x && typeof x.y` que no short-circuita porque `typeof undefined` es la string `"undefined"`, truthy). Cambiado a `typeof x?.y`.

**Tests**: 499/499 pass (407 + 20 + 72). `npm test` corre los 3 suites; `npm run test:oit` corre solo los 12 CA A-L nuevos. Los tests mockean la Muxy API completamente con un programmable factory (`muxy.on('git.repoInfo', () => { ... })`), y assertan:
- Cuáles API calls se hicieron y en qué orden
- Los args correctos (positional `[name, projectId]` para `muxy.worktrees.switchTo`, object `{identifier}` para `muxy.git.worktree.switchTo`)
- Que `git.repoInfo` se llamó ≥2 veces cuando hubo switch (verify pass)
- Los toasts y statuses emitidos
- Los log calls de cada step (CA K)

El test CA F (worktree match, not active) es el test "anti-regresión" principal: asserta que la verify pass corrió y que el switch fue posicional. Si alguien rompe la API shape o quita el verify pass en el futuro, este test falla.

**Después de upgrade**: recargá Muxy, aceptá los 2 consent prompts nuevos (`tabs:read`, `projects:read`), y reintentá "Open in Terminal" en un worktree no activo. El log ahora debería mostrar todo el flujo: `step=1 tabs.list() returned N → step=3 projects.list() returned N → step=4 projects.switchTo ok → step=5 worktrees.list returned N → step=6 switch VERIFIED → step=7 tabs.open ok`.

## v0.6.1 — Diagnostic logging for Open in Terminal

User reported that "Open in Terminal" only opened a new terminal with `cd <dir>` wrapping, without switching the active Muxy project/worktree. Root cause was unclear, so I added **detailed tagged logging** in every step of `openInTerminal` to diagnose what's actually happening at runtime.

All logs are tagged `[openInTerminal]` and emitted via two helpers (`olog` / `owarn`) so they are easy to grep in Muxy's extension log file.

**What gets logged:**

- `step=0` — start (provider, id, resolved projectDir, resumeCmd)
- `step="pre"` — API availability matrix (e.g. `muxy.tabs.open=function muxy.projects=undefined muxy.worktrees.list=function muxy.git.worktree.switchTo=function`)
- `step=1` — `tabs.list()` returns N tab(s), first tab keys, existingTab match
- `step=2` — `tabs.switchTo(existingTab)` ok/fail
- `step=3` — `projects.list()` returns N, first project keys, projects sample, `findBestProjectForPath` match
- `step="3b"` — project NOT in Muxy, opening new workspace
- `step=4` — `isProjectActive` check, `projects.switchTo(id)` ok/fail
- `step=5` — `worktrees.list()` (or `git.worktrees()`) returns N, worktree keys, worktrees sample
- `step=6` — `findBestWorktreeForPath` match, `muxy.git.repoInfo()`, `isWorktreeActive` decision, `worktrees.switchTo(identifier, project)` (positional, app-level) **or** `git.worktree.switchTo({identifier})` (object, git-level) ok/fail, **plus a verify pass** that re-reads `repoInfo()` to confirm the switch actually took effect
- `step=7` — `tabs.open({directory, command})` ok/fail, with fallback to command-only
- `step="7b"` — no matching worktree, opening new workspace
- `step="fallback"` — no projectDir, opening command-only

**Key fixes found while adding the logging** (and the reason this version is v0.6.1, not v0.7):

1. **`muxy.worktrees.switchTo(identifier, project)`** — positional args (was `{ project: projectId }`)
2. **`muxy.git.worktree.switchTo({ identifier })`** — object form (was bare string)
3. **Verify pass after switch** — re-read `repoInfo()` to confirm the worktree actually changed

**Tests**: 407 smoke + 20 integration = 427/427 pass.

## v0.6 — Refined Open in Terminal

"Open in Terminal" ahora **verifica si el proyecto ya está abierto** antes de abrir uno nuevo:

1. **`tabs.list()`** → busca terminal ya en el directorio (o subdirectorio); si existe, **`tabs.switchTo()`** y termina
2. **`projects.list()`** → verifica si el proyecto está en Muxy; si no está, abre nuevo workspace
3. **`projects.switchTo()`** → si el proyecto existe pero no está activo
4. **`worktrees.list()`** (o fallback a `git.worktrees()`) → busca el worktree que contiene la conversación
5. **`worktrees.switchTo()`** → si hay worktree match y no está activo
6. **`tabs.open()`** → abre terminal en el worktree correcto con `cd "<dir>"` wrapping

Resultado: un solo click te lleva **al tab existente** si ya está abierto, o **abre nuevo workspace** en el worktree correcto con la terminal lista para `claude --resume` o `opencode -s`.

**Nuevas utilidades puras** en `utils.js` (testeables sin Muxy):
- `findBestWorktreeForPath(worktrees, targetPath)` — longest-prefix match entre worktrees
- `isWorktreeActive(worktree, activePath)` — chequea `isActive` field con fallback a path match

**FEATURES.md**: spec exhaustiva (UI, helpers, formatos, troubleshooting, API completa).

**Tests**: 357 smoke + 20 integration = 377/377 pass.

## v0.3.1 Bugfixes

- **#1 Open in Terminal**: Muxy rechazaba `directory` si no estaba dentro del worktree activo. Ahora se hace **try con `directory` y fallback sin `directory`**: si Muxy rechaza, retry sin el param y se abre en el cwd default (active Muxy project). Toast informativo indica que el cwd es el default.
- **#2 Copy as Markdown**: El `printf '%s' ${JSON.stringify(markdown)}` tenía problemas de escape en el shell. Ahora se escribe a `/tmp` en chunks de base64 y luego `pbcopy < tmp`.
- **#3 Save as Markdown**: El heredoc con todo el markdown colgaba Muxy. Ahora se usa base64 chunked + `base64 -d` (testeado con 1MB de Unicode + shell-special chars). En v0.4, la exportación usa el modal + download nativo.
- **#4 Proyecto duplicado**: El mismo repo podía aparecer dos veces en el dropdown (Claude encoded vs OpenCode absolute) o como N entries si tenías subdirs. Ahora `projectDisplayGroups` deduplica por toplevel y `extractRepoLabel` sube por los parents.

## v0.5 — Auto-switch Muxy project

El fallback del v0.3.1 (abrir sin `directory`) dejaba la terminal en el cwd del Muxy project activo, no en la ruta de la conversación. Ahora:

1. `muxy.projects.list()` → busca el Muxy project que **contiene** la ruta de la conversación (path más específico gana)
2. Si el match no es el active project → `muxy.projects.switchTo(match.id)` (con toast "Switched project → <name>")
3. `muxy.tabs.open({directory, command})` ahora funciona porque el active worktree ES el match
4. Si no hay match (la carpeta no es un Muxy project) → toast informativo y abre sin directory

Nuevas utilidades puras en `utils.js` (testeables):
- `pathInside(child, parent)` — match estricto con separador `/` (evita `/foo/barx` matching `/foo/bar`)
- `findBestProjectForPath(projects, targetPath)` — pick longest match, soporta `path`/`root`/`directory`/`worktree` como field names

Permiso nuevo: `projects:write`.

## v0.4 — Export modal con preview

El botón "Export" antes abría un sub-menú con Copy/Save directo a `~/Downloads/ai-history/`. Ahora abre un **modal centrado** con:

- **Preview del markdown** en un área scrolleable con `max-height: 500px` (no se expande más allá)
- **Botón Copy** — copia al portapapeles
- **Botón Save…** — usa `Blob` + `<a download>` para disparar el file picker nativo del OS (Finder) y dejar al usuario elegir destino
- **Botón ×** o **Esc** o **click en backdrop** para cerrar

El modal reusa el markdown ya cargado (no re-lee el JSONL) para que el preview sea instantáneo.

## Desarrollo

```bash
npm install
npm run dev                       # Vite dev server en :5173
npm run build                     # Genera dist/
node tests/test-parsers.mjs       # 220 smoke tests
node tests/test-chunked-write.mjs # 20 integration tests (round-trip base64)
```

## Instalación

El manifest de Muxy detecta automáticamente la extensión en `~/.config/muxy/extensions/ai-history/`. Reinicia Muxy para que cargue.

## Atajos de teclado

- `Cmd+Shift+H` — toggle del panel
- `Esc` — cerrar menú 3-dot o cancelar rename
- `Enter` en input de rename — guardar
