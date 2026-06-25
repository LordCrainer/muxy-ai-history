// openInTerminal — extracted from main.js for testability.
// All Muxy API access and side effects are injected via `deps`.
//
// deps = {
//   muxy,                      // Muxy API object (or mock in tests)
//   toast,                     // (opts) => void
//   setStatus,                 // (text, kind) => void
//   state,                     // snapshot of state.all/provider/projectFilter/search/customTitles
//   log: { olog, owarn },      // logging helpers, signatures (step, msg, extra?)
//   getVisibleConversations,
//   applyCustomTitle,
//   decodeClaudeProject,
//   buildResumeCommand,
//   findBestProjectForPath,
//   findBestWorktreeForPath,
//   isWorktreeActive,
//   pathInside
// }
//
// Returns a Promise<void>. All Muxy API calls go through `deps.muxy`.

export async function openInTerminal(deps, provider, id) {
  const {
    muxy, toast, setStatus, state, log,
    getVisibleConversations, applyCustomTitle, decodeClaudeProject, buildResumeCommand,
    findBestProjectForPath, findBestWorktreeForPath, isWorktreeActive, pathInside
  } = deps;
  const { olog, owarn } = log;

  olog(0, `start provider=${provider} id=${id}`);

  const resumeCmd = buildResumeCommand(provider, id);
  if (!resumeCmd) {
    owarn(0, `unknown provider: ${provider}`);
    toast({ title: 'Open failed', body: `Unknown provider: ${provider}`, variant: 'error' });
    return;
  }
  const visible = getVisibleConversations(state.all, {
    provider: state.provider,
    projectFilter: state.projectFilter,
    search: state.search
  }).map((c) => applyCustomTitle(c, state.customTitles));
  const conv = visible.find((c) => c.id === id && c.provider === provider) ||
    state.all.find((c) => c.id === id && c.provider === provider);
  const decoded = conv ? decodeClaudeProject(conv.project) : null;
  const projectDir = decoded && decoded.startsWith('/') ? decoded : null;
  const safeDir = projectDir ? projectDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`') : null;
  const cmd = projectDir ? `cd "${safeDir}" && ${resumeCmd}` : resumeCmd;

  olog(0, `resolved projectDir=${projectDir} resumeCmd=${resumeCmd}`);

  if (typeof muxy === 'undefined' || !muxy.tabs) {
    owarn('pre', 'muxy.tabs API not available');
    toast({ title: 'Open failed', body: 'tabs API not available', variant: 'error' });
    return;
  }

  olog('pre', `muxy.tabs.open=${typeof muxy.tabs.open} muxy.tabs.list=${typeof muxy.tabs.list} muxy.tabs.switchTo=${typeof muxy.tabs.switchTo}`);
  olog('pre', `muxy.projects=${typeof muxy.projects} muxy.worktrees=${typeof muxy.worktrees} muxy.git=${typeof muxy.git}`);
  if (typeof muxy.worktrees !== 'undefined') {
    olog('pre', `muxy.worktrees.list=${typeof muxy.worktrees.list} muxy.worktrees.switchTo=${typeof muxy.worktrees.switchTo}`);
  }
  if (typeof muxy.git !== 'undefined') {
    olog('pre', `muxy.git.worktrees=${typeof muxy.git.worktrees} muxy.git.worktree=${typeof muxy.git.worktree?.switchTo} muxy.git.repoInfo=${typeof muxy.git.repoInfo}`);
  }

  if (!projectDir) {
    olog('fallback', 'no projectDir, opening terminal with command only');
    try {
      await muxy.tabs.open({ kind: 'terminal', command: resumeCmd });
      olog('fallback', 'tabs.open(command) ok');
      toast({ title: 'Opened in terminal', body: resumeCmd.slice(0, 60), variant: 'info' });
      setStatus(`Opened terminal: ${resumeCmd}`, 'ok');
    } catch (e) {
      owarn('fallback', `tabs.open(command) failed: ${e.message || e}`);
      toast({ title: 'Open failed', body: e.message || String(e), variant: 'error' });
    }
    return;
  }

  // 1) Check if project is already open in Muxy (tabs list)
  olog(1, 'checking tabs.list() for existing terminal in projectDir');
  let existingTab = null;
  if (typeof muxy.tabs.list === 'function') {
    try {
      const tabs = await muxy.tabs.list();
      olog(1, `tabs.list() returned ${(tabs || []).length} tab(s)`);
      if (Array.isArray(tabs) && tabs.length > 0) {
        olog(1, `first tab keys: ${Object.keys(tabs[0] || {}).join(',')}`);
      }
      existingTab = (tabs || []).find((t) => {
        if (!t) return false;
        if (t.type && t.type !== 'terminal') return false;
        const a = t.data && t.data.directory;
        const b = t.cwd;
        return (a && pathInside(projectDir, a)) || (b && pathInside(projectDir, b));
      });
      olog(1, `existingTab match=${existingTab ? `id=${existingTab.id ?? existingTab} dir=${existingTab.data?.directory || existingTab.cwd}` : 'null'}`);
    } catch (e) {
      owarn(1, `tabs.list() threw: ${e.message || e}`);
    }
  } else {
    olog(1, 'muxy.tabs.list is NOT a function (skipping)');
  }

  // 2) If tab exists → switch to it
  if (existingTab && typeof muxy.tabs.switchTo === 'function') {
    try {
      olog(2, `switching to existing tab id=${existingTab.id ?? existingTab}`);
      await muxy.tabs.switchTo(existingTab.id ?? existingTab);
      olog(2, 'tabs.switchTo ok');
      toast({ title: 'Switched to terminal', body: `Project already open`, variant: 'info' });
      setStatus(`Switched to existing terminal for ${projectDir}`, 'ok');
      return;
    } catch (e) {
      owarn(2, `tabs.switchTo failed: ${e.message || e}`);
    }
  }

  // 3) Tab doesn't exist → check if project is in Muxy projects list
  olog(3, 'checking projects.list() for projectDir');
  let targetProject = null;
  if (typeof muxy.projects !== 'undefined' && typeof muxy.projects.list === 'function') {
    try {
      const projects = await muxy.projects.list();
      olog(3, `projects.list() returned ${(projects || []).length} project(s)`);
      if (Array.isArray(projects) && projects.length > 0) {
        olog(3, `first project keys: ${Object.keys(projects[0] || {}).join(',')}`);
        olog(3, `projects sample: ${JSON.stringify(projects.slice(0, 3).map(p => ({ id: p.id, name: p.name, path: p.path, root: p.root })))}`);
      }
      targetProject = findBestProjectForPath(projects, projectDir);
      olog(3, `findBestProjectForPath match=${targetProject ? `id=${targetProject.id || targetProject.name} path=${targetProject.path}` : 'null'}`);
    } catch (e) {
      owarn(3, `projects.list() threw: ${e.message || e}`);
    }
  } else {
    olog(3, 'muxy.projects.list is NOT a function (skipping)');
  }

  if (!targetProject) {
    olog('3b', 'project NOT in Muxy, opening new workspace with cd wrapping');
    try {
      await muxy.tabs.open({ kind: 'terminal', command: cmd });
      olog('3b', 'tabs.open(command with cd) ok');
      toast({ title: 'Opened in terminal', body: `New workspace (project not in Muxy)`, variant: 'info' });
      setStatus(`Opened terminal in new workspace: ${projectDir}`, 'ok');
    } catch (e) {
      owarn('3b', `tabs.open failed: ${e.message || e}`);
      toast({ title: 'Open failed', body: e.message || String(e), variant: 'error' });
    }
    return;
  }

  // 4) Project exists in Muxy → switch to it
  olog(4, `checking if project already active (id=${targetProject.id || targetProject.name})`);
  const alreadyActive = isProjectActive({ muxy, pathInside }, targetProject);
  olog(4, `isProjectActive=${alreadyActive}`);
  if (!alreadyActive && typeof muxy.projects !== 'undefined' && typeof muxy.projects.switchTo === 'function') {
    try {
      const switchId = targetProject.id || targetProject.name || targetProject.path;
      olog(4, `projects.switchTo(${switchId})`);
      await muxy.projects.switchTo(switchId);
      olog(4, 'projects.switchTo ok');
      const label = targetProject.name || targetProject.path;
      toast({ title: 'Switched project', body: `→ ${label}`, variant: 'info' });
      setStatus(`Switched Muxy project to ${label}`, 'ok');
    } catch (e) {
      owarn(4, `projects.switchTo failed: ${e.message || e}`);
    }
  } else if (alreadyActive) {
    olog(4, 'project already active, skipping switchTo');
  } else {
    olog(4, 'muxy.projects.switchTo is NOT a function (skipping)');
  }

  // 5) Check if project has worktrees and find the matching one
  olog(5, 'checking worktrees.list() for projectDir');
  let worktrees = null;
  let listFn = null;
  let listFnName = null;
  const projectId = targetProject.id || targetProject.name || targetProject.path;
  if (typeof muxy.worktrees !== 'undefined' && typeof muxy.worktrees.list === 'function') {
    listFn = muxy.worktrees.list;
    listFnName = 'muxy.worktrees.list';
  } else if (typeof muxy.git !== 'undefined' && typeof muxy.git.worktrees === 'function') {
    listFn = muxy.git.worktrees;
    listFnName = 'muxy.git.worktrees';
  }
  olog(5, `using listFn=${listFnName || 'NONE'}`);

  if (listFn) {
    try {
      olog(5, `calling ${listFnName}({project: ${projectId}})`);
      worktrees = await listFn({ project: projectId });
      olog(5, `${listFnName} returned ${Array.isArray(worktrees) ? worktrees.length : 'non-array'} worktree(s)`);
      if (Array.isArray(worktrees) && worktrees.length > 0) {
        olog(5, `worktree keys: ${Object.keys(worktrees[0] || {}).join(',')}`);
        olog(5, `worktrees sample: ${JSON.stringify(worktrees.slice(0, 5).map(w => ({ path: w.path, branch: w.branch, head: w.head, isBare: w.isBare, isDetached: w.isActive, active: w.active })))}`);
      }
    } catch (e) {
      owarn(5, `${listFnName} threw: ${e.message || e}`);
    }
  } else {
    olog(5, 'no worktree listFn available (skipping worktree logic)');
  }

  // 6) If worktrees exist, find matching one and switch
  if (Array.isArray(worktrees) && worktrees.length > 0) {
    olog(6, `finding best worktree match for projectDir=${projectDir}`);
    const matchWt = findBestWorktreeForPath(worktrees, projectDir);
    olog(6, `match=${matchWt ? `path=${matchWt.path} branch=${matchWt.branch} name=${matchWt.name}` : 'null'}`);

    if (matchWt) {
      // Detect active worktree via git.repoInfo()
      let activePath = null;
      let activeInfo = null;
      if (typeof muxy.git !== 'undefined' && typeof muxy.git.repoInfo === 'function') {
        try {
          olog(6, `calling muxy.git.repoInfo()`);
          activeInfo = await muxy.git.repoInfo();
          activePath = activeInfo && activeInfo.root;
          olog(6, `repoInfo=${JSON.stringify(activeInfo)}`);
        } catch (e) {
          owarn(6, `muxy.git.repoInfo() threw: ${e.message || e}`);
        }
      } else {
        olog(6, 'muxy.git.repoInfo is NOT a function');
      }

      const wtAlreadyActive = isWorktreeActive(matchWt, activePath);
      olog(6, `wtAlreadyActive=${wtAlreadyActive} (activePath=${activePath} matchPath=${matchWt.path})`);

      if (!wtAlreadyActive) {
        const wtSwitchId = matchWt.name || matchWt.branch || matchWt.path || matchWt.id;
        let switchFn = null;
        let switchFnName = null;
        let switchFnArgs = null;
        if (typeof muxy.worktrees !== 'undefined' && typeof muxy.worktrees.switchTo === 'function') {
          switchFn = muxy.worktrees.switchTo;
          switchFnName = 'muxy.worktrees.switchTo';
          switchFnArgs = [wtSwitchId, projectId];
        } else if (typeof muxy.git !== 'undefined' && muxy.git.worktree && typeof muxy.git.worktree.switchTo === 'function') {
          switchFn = muxy.git.worktree.switchTo;
          switchFnName = 'muxy.git.worktree.switchTo';
          switchFnArgs = [{ identifier: wtSwitchId }];
        }
        olog(6, `using switchFn=${switchFnName || 'NONE'} args=${JSON.stringify(switchFnArgs)}`);

        if (switchFn && wtSwitchId) {
          try {
            olog(6, `calling ${switchFnName}(${JSON.stringify(switchFnArgs)})`);
            await switchFn(...switchFnArgs);
            olog(6, `${switchFnName} ok`);
            const label = matchWt.name || matchWt.branch || matchWt.path;
            toast({ title: 'Switched worktree', body: `→ ${label}`, variant: 'info' });
            setStatus(`Switched Muxy worktree to ${label}`, 'ok');

            // Verify the switch actually took effect
            if (typeof muxy.git !== 'undefined' && typeof muxy.git.repoInfo === 'function') {
              try {
                const verifyInfo = await muxy.git.repoInfo();
                olog(6, `verify after switch: repoInfo=${JSON.stringify(verifyInfo)}`);
                if (verifyInfo && verifyInfo.root !== activePath) {
                  olog(6, `switch VERIFIED (active changed ${activePath} → ${verifyInfo.root})`);
                } else {
                  owarn(6, `switch may not have taken effect (root unchanged: ${verifyInfo?.root})`);
                }
              } catch (e) {
                owarn(6, `verify repoInfo threw: ${e.message || e}`);
              }
            }
          } catch (e) {
            owarn(6, `${switchFnName} failed: ${e.message || e}`);
          }
        } else {
          owarn(6, 'no worktree switchFn available or no wtSwitchId');
        }
      } else {
        olog(6, 'worktree already active, skipping switchTo');
      }

      // Open terminal in the worktree
      olog(7, `opening terminal with directory=${projectDir}`);
      try {
        await muxy.tabs.open({ kind: 'terminal', command: cmd, directory: projectDir });
        olog(7, 'tabs.open(directory, command) ok');
        toast({ title: 'Opened in terminal', body: cmd.slice(0, 60), variant: 'info' });
        setStatus(`Opened terminal: ${cmd} (cwd: ${projectDir})`, 'ok');
      } catch (e) {
        owarn(7, `tabs.open(directory, command) failed: ${e.message || e}`);
        try {
          olog(7, 'fallback: tabs.open(command only)');
          await muxy.tabs.open({ kind: 'terminal', command: cmd });
          olog(7, 'tabs.open(command only) ok');
          toast({ title: 'Opened in terminal', body: `${cmd.slice(0, 40)} (worktree switch failed)`, variant: 'info' });
          setStatus(`Opened terminal: ${cmd} (fallback cwd)`, 'ok');
        } catch (e2) {
          owarn(7, `tabs.open(command only) failed: ${e2.message || e2}`);
          toast({ title: 'Open failed', body: e2.message || String(e2), variant: 'error' });
        }
      }
      return;
    }
  } else {
    olog(6, 'no worktrees array, skipping worktree match');
  }

  // 7) No worktree match → open new workspace
  olog('7b', 'no matching worktree, opening new workspace');
  try {
    await muxy.tabs.open({ kind: 'terminal', command: cmd, directory: projectDir });
    olog('7b', 'tabs.open(directory, command) ok');
    toast({ title: 'Opened in terminal', body: `New workspace (no matching worktree)`, variant: 'info' });
    setStatus(`Opened terminal in new workspace: ${projectDir}`, 'ok');
  } catch (e) {
    owarn('7b', `tabs.open(directory, command) failed: ${e.message || e}`);
    try {
      olog('7b', 'fallback: tabs.open(command only)');
      await muxy.tabs.open({ kind: 'terminal', command: cmd });
      olog('7b', 'tabs.open(command only) ok');
      toast({ title: 'Opened in terminal', body: `${cmd.slice(0, 40)} (new workspace, fallback cwd)`, variant: 'info' });
      setStatus(`Opened terminal: ${cmd} (fallback cwd)`, 'ok');
    } catch (e2) {
      owarn('7b', `tabs.open(command only) failed: ${e2.message || e2}`);
      toast({ title: 'Open failed', body: e2.message || String(e2), variant: 'error' });
    }
  }
}

// Pure helper, extracted from main.js.
// Returns true if the project is the currently active Muxy project.
export function isProjectActive({ muxy, pathInside }, project) {
  if (!project) return false;
  if (project.isActive === true) return true;
  if (project.isActive === false) return false;
  if (project.active === true) return true;
  if (project.active === false) return false;
  if (typeof muxy === 'undefined' || !muxy.git || typeof muxy.git.repoInfo !== 'function') {
    return false;
  }
  try {
    const info = muxy.git.repoInfo();
    const activeRoot = info && info.root;
    if (!activeRoot || !project.path) return false;
    return pathInside(activeRoot, project.path);
  } catch {
    return false;
  }
}
