'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { GraderClient } = require('./lib/client');
const { runTests } = require('./lib/runner');
const { statementHtml } = require('./lib/statement');

const EXAM = /(?<![a-z])exam(?![a-z])/i;
const cfg = () => vscode.workspace.getConfiguration('nattee');
const safeName = (s) => s.replace(/[^\w\-.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'problem';
const clip = (s) => (s.length > 3000 ? s.slice(0, 3000) + ' ... (truncated)' : s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function activate(context) {
  const libDir = path.join(context.extensionPath, 'lib');
  const cacheRoot = () => {
    const host = new URL(cfg().get('rootUrl')).host;
    return path.join(context.globalStorageUri.fsPath, host);
  };
  const problemDir = (id) => path.join(cacheRoot(), String(id));

  // ---------------------------------------------------------------- session
  let client = null;
  let problems = [];

  const setLoggedIn = (v) => vscode.commands.executeCommand('setContext', 'nattee.loggedIn', v);

  async function connect(uid, password) {
    const c = new GraderClient(cfg().get('rootUrl'));
    await c.login(uid, password);
    client = c;
  }

  async function ensureClient() {
    if (client) return client;
    const uid = await context.secrets.get('nattee.uid');
    const pw = await context.secrets.get('nattee.password');
    if (!uid || !pw) throw new Error('Not signed in. Run "Nattee: Sign In".');
    await connect(uid, pw);
    return client;
  }

  // Runs fn(client); if the session has expired, signs in again once and retries.
  async function withClient(fn) {
    try {
      return await fn(await ensureClient());
    } catch (e) {
      if (/Not signed in/.test(e.message)) throw e;
      client = null;
      return await fn(await ensureClient());
    }
  }

  const fail = (e) => vscode.window.showErrorMessage(`Nattee: ${e.message}`);

  // --------------------------------------------------------------- problems
  const cachedProblemsFile = () => path.join(cacheRoot(), 'problems.json');

  function loadCachedProblems() {
    try { problems = JSON.parse(fs.readFileSync(cachedProblemsFile(), 'utf8')); } catch { problems = []; }
  }

  async function refreshProblems() {
    const list = await withClient((c) => c.listProblems());
    problems = list.filter((p) => p.hasTestcases && !(cfg().get('hideExams') && (EXAM.test(p.code) || EXAM.test(p.name))));
    fs.mkdirSync(cacheRoot(), { recursive: true });
    fs.writeFileSync(cachedProblemsFile(), JSON.stringify(problems));
    tree.fire();
  }

  const groupOf = (p) => p.code.split('_').slice(0, 2).join('_') || p.code;

  class ProblemTree {
    constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; }
    fire() { this._e.fire(); }
    getTreeItem(el) { return el; }
    getChildren(el) {
      if (!el) {
        const groups = [...new Set(problems.map(groupOf))].sort();
        return groups.map((g) => {
          const item = new vscode.TreeItem(g, vscode.TreeItemCollapsibleState.Collapsed);
          item.groupKey = g;
          item.iconPath = new vscode.ThemeIcon('folder');
          return item;
        });
      }
      return problems.filter((p) => groupOf(p) === el.groupKey).sort((a, b) => a.code.localeCompare(b.code)).map((p) => {
        const item = new vscode.TreeItem(p.code, vscode.TreeItemCollapsibleState.None);
        item.description = p.name.replace(/^\d+_[A-Za-z]+_/, '').replace(/_/g, ' ');
        item.tooltip = `${p.code}\n${p.name}`;
        item.contextValue = 'problem';
        item.problem = p;
        item.iconPath = new vscode.ThemeIcon('file-pdf');
        item.command = { command: 'nattee.openProblem', title: 'Open', arguments: [item] };
        return item;
      });
    }
  }
  const tree = new ProblemTree();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('nattee.problems', tree));

  // ------------------------------------------------------- statements/tests
  async function getStatement(p) {
    const dir = problemDir(p.id);
    const existing = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith('statement.'));
    if (existing) return path.join(dir, existing);
    const { data, ext } = await withClient((c) => c.fetchStatement(p.id));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `statement${ext}`);
    fs.writeFileSync(file, data);
    return file;
  }

  async function getTests(p) {
    const file = path.join(problemDir(p.id), 'tests.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }
    const cases = await withClient((c) => c.fetchTestcases(p.id));
    fs.mkdirSync(problemDir(p.id), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cases));
    return cases;
  }

  let statementPanel = null;
  let shownProblem = null;

  async function showStatement(p, preserveFocus = true) {
    if (shownProblem === p.id && statementPanel) { statementPanel.reveal(vscode.ViewColumn.Beside, preserveFocus); return; }
    const file = await getStatement(p);
    if (path.extname(file) !== '.pdf') { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); return; }
    if (!statementPanel) {
      statementPanel = vscode.window.createWebviewPanel('natteeStatement', p.code,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(cacheRoot()), vscode.Uri.file(libDir)] });
      statementPanel.onDidDispose(() => { statementPanel = null; shownProblem = null; });
    } else {
      statementPanel.reveal(vscode.ViewColumn.Beside, preserveFocus);
    }
    statementPanel.title = p.code;
    statementPanel.webview.html = statementHtml(statementPanel.webview, file, libDir);
    shownProblem = p.id;
  }

  // ------------------------------------------------------ file <-> problem
  const links = () => context.globalState.get('nattee.links', {});
  const linkKey = (f) => path.normalize(f).toLowerCase();
  // Explicit link first; otherwise a file named after a problem code (05_List_15.py) links itself.
  const linkedProblem = (file) => {
    const id = links()[linkKey(file)];
    const explicit = id && problems.find((p) => p.id === id);
    if (explicit) return explicit;
    const stem = path.basename(file, path.extname(file));
    return problems.find((p) => {
      const code = safeName(p.code);
      return stem.startsWith(code) && !/^\d/.test(stem.slice(code.length));
    });
  };
  const setLink = (file, id) => context.globalState.update('nattee.links', { ...links(), [linkKey(file)]: id });

  function updateEditorState() {
    const ed = vscode.window.activeTextEditor;
    const p = ed && ed.document.uri.scheme === 'file' ? linkedProblem(ed.document.fileName) : null;
    vscode.commands.executeCommand('setContext', 'nattee.activeFileLinked', !!p);
    if (p) { status.text = `$(play) Run ${p.code}`; status.show(); } else status.hide();
    return p;
  }

  async function pickProblem() {
    if (!problems.length) await refreshProblems();
    const pick = await vscode.window.showQuickPick(
      problems.map((p) => ({ label: p.code, description: p.name, p })), { placeHolder: 'Choose a problem', matchOnDescription: true });
    return pick && pick.p;
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'nattee.runTests';
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    const p = updateEditorState();
    if (p) showStatement(p).catch(() => {});
  }));

  // ---------------------------------------------------------------- results
  let resultsView = null;
  let resultsHtml = '<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px">Save a linked solution file (or press ▶) to see test results here.</body>';
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('nattee.results', {
    resolveWebviewView(view) {
      resultsView = view;
      view.webview.html = resultsHtml;
      view.onDidDispose(() => { resultsView = null; });
    },
  }));

  function showResults(p, cases, results) {
    const passed = results.filter((r) => r.verdict === 'PASS').length;
    const rows = results.map((r, i) => {
      const tc = cases[i];
      const bad = r.verdict !== 'PASS';
      return `<details ${bad && results.findIndex((x) => x.verdict !== 'PASS') === i ? 'open' : ''}>
        <summary><span class="v ${r.verdict}">${r.verdict}</span> Test ${i + 1} <span class="ms">${r.ms} ms</span></summary>
        <div class="grid">
          <div><h4>Input</h4><pre>${esc(clip(tc.input))}</pre></div>
          <div><h4>Expected</h4><pre>${esc(clip(tc.output))}</pre></div>
          <div><h4>Your output</h4><pre>${esc(clip(r.stdout))}</pre></div>
        </div>${r.stderr ? `<h4>stderr</h4><pre class="err">${esc(clip(r.stderr))}</pre>` : ''}
      </details>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
      <style>
        body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}
        .sum{font-size:1.2em;margin-bottom:12px} .ms{opacity:.6;margin-left:8px}
        summary{cursor:pointer;padding:4px 0} .v{display:inline-block;min-width:44px;text-align:center;border-radius:3px;padding:0 6px;color:#fff;font-weight:600}
        .PASS{background:#2e7d32}.FAIL{background:#c62828}.TLE{background:#ef6c00}.RE{background:#6a1b9a}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px} pre{background:var(--vscode-textCodeBlock-background);padding:6px;overflow:auto;max-height:240px;margin:0;white-space:pre-wrap;word-break:break-all}
        .err{color:var(--vscode-errorForeground)} h4{margin:6px 0 2px}
      </style></head><body>
      <div class="sum"><b>${esc(p.code)}</b> — ${passed}/${results.length} passed</div>${rows}</body></html>`;
    resultsHtml = html;
    if (resultsView) {
      resultsView.webview.html = html;
      resultsView.description = `${p.code}: ${passed}/${results.length}`;
      resultsView.show(true);
    } else {
      vscode.commands.executeCommand('nattee.results.focus');
    }
  }

  // --------------------------------------------------------------- commands
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...a) => {
    try { await fn(...a); } catch (e) { fail(e); }
  }));

  reg('nattee.login', async () => {
    const uid = await vscode.window.showInputBox({ prompt: 'NatteeGrader username', ignoreFocusOut: true });
    if (!uid) return;
    const password = await vscode.window.showInputBox({ prompt: 'NatteeGrader password', password: true, ignoreFocusOut: true });
    if (!password) return;
    await connect(uid, password);
    await context.secrets.store('nattee.uid', uid);
    await context.secrets.store('nattee.password', password);
    await setLoggedIn(true);
    await refreshProblems();
    vscode.window.showInformationMessage(`Nattee: signed in, ${problems.length} problems loaded.`);
  });

  reg('nattee.logout', async () => {
    client = null; problems = [];
    await context.secrets.delete('nattee.uid');
    await context.secrets.delete('nattee.password');
    await setLoggedIn(false);
    tree.fire();
  });

  reg('nattee.refresh', refreshProblems);

  reg('nattee.clearCache', async () => {
    fs.rmSync(cacheRoot(), { recursive: true, force: true });
    problems = [];
    tree.fire();
    if (client || await context.secrets.get('nattee.uid')) await refreshProblems();
    vscode.window.showInformationMessage('Nattee: cache cleared, statements and test cases will be downloaded again.');
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('nattee.rootUrl')) return;
    client = null; loadCachedProblems(); tree.fire();
    context.secrets.get('nattee.uid').then((u) => u && refreshProblems()).catch(fail);
  }));

  reg('nattee.openProblem', async (item) => {
    const p = item && item.problem ? item.problem : await pickProblem();
    if (p) await showStatement(p, false);
  });

  reg('nattee.createSolution', async (item) => {
    const p = item && item.problem ? item.problem : await pickProblem();
    if (!p) return;
    let folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) throw new Error('Open a folder in VS Code first.');
    let ext = cfg().get('defaultExtension');
    if (!ext.startsWith('.')) ext = '.' + ext;
    const file = path.join(folder.uri.fsPath, `${safeName(p.code)}${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    await setLink(file, p.id);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    updateEditorState();
    await showStatement(p);
  });

  reg('nattee.linkFile', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    const p = await pickProblem();
    if (!p) return;
    await setLink(ed.document.fileName, p.id);
    updateEditorState();
    await showStatement(p);
  });

  reg('nattee.showStatement', async () => {
    const ed = vscode.window.activeTextEditor;
    const p = ed && linkedProblem(ed.document.fileName);
    if (!p) throw new Error('This file is not linked to a problem. Use "Nattee: Link Current File to Problem".');
    await showStatement(p, false);
  });

  async function runActive(auto) {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    let p = linkedProblem(ed.document.fileName);
    if (!p) {
      if (auto) return;
      p = await pickProblem();
      if (!p) return;
      await setLink(ed.document.fileName, p.id);
      updateEditorState();
    }
    await ed.document.save();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running ${p.code}...` }, async () => {
      const cases = await getTests(p);
      let results;
      try {
        results = await runTests(ed.document.fileName, cases, {
          pythonPath: cfg().get('pythonPath'), cppCompiler: cfg().get('cppCompiler'), cCompiler: cfg().get('cCompiler'),
          timeoutMs: cfg().get('timeLimitSeconds') * 1000,
        });
      } catch (e) {
        if (e.details) { vscode.window.showErrorMessage(`Nattee: ${e.message}
${e.details.slice(0, 400)}`); return; }
        throw e;
      }
      showResults(p, cases, results);
      const passed = results.filter((r) => r.verdict === 'PASS').length;
      (passed === results.length ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(
        `${p.code}: ${passed}/${results.length} tests passed`);
    });
  }

  reg('nattee.runTests', () => runActive(false));

  let running = false;
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    const ed = vscode.window.activeTextEditor;
    if (running || !cfg().get('runOnSave') || !ed || ed.document !== doc || !linkedProblem(doc.fileName)) return;
    running = true;
    runActive(true).catch(fail).finally(() => { running = false; });
  }));

  // ------------------------------------------------------------------ start
  loadCachedProblems();
  updateEditorState();
  context.secrets.get('nattee.uid').then(async (uid) => {
    await setLoggedIn(!!uid);
    if (uid && !problems.length) refreshProblems().catch(fail);
    updateEditorState();
    tree.fire();
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
