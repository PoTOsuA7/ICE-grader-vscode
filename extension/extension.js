'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GraderClient, decodeEntities } = require('./lib/client');
const { runTests, runSingle, terminalCommand, dataSandbox, killTree } = require('./lib/runner');
const { programTerminal } = require('./lib/programTerminal');
const { copyPngToClipboard } = require('./lib/clipboardImage');
const { localResultsHtml, singleResultHtml, submissionHtml, explanationHtml, emptyHtml, mockReportHtml } = require('./lib/resultsHtml');
const { pickProblems, clock, stamp, summarize } = require('./lib/mockExam');
const { statementHtml } = require('./lib/statement');
const { explainFailures, MAX_FAILURES } = require('./lib/aiExplain');
const { safeName, chapterOf, solutionPath } = require('./lib/layout');

const cfg = () => vscode.workspace.getConfiguration('nattee');

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

  // The grader the password is for. It is only ever sent there, and only over https (http just for a local test
  // server), so changing nattee.rootUrl can't send a saved password somewhere else.
  const DEFAULT_ORIGIN = 'https://2190101.nattee.net';
  function graderOrigin() {
    const u = new URL(cfg().get('rootUrl'));
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
      throw new Error(`nattee.rootUrl must start with https:// (got ${u.origin}) - your password would be sent unencrypted.`);
    }
    return u.origin;
  }

  // A saved sign-in exists and it is for the grader in nattee.rootUrl.
  async function signedInHere() {
    if (!(await context.secrets.get('nattee.uid'))) return false;
    const savedFor = (await context.secrets.get('nattee.origin')) || DEFAULT_ORIGIN;
    try { return graderOrigin() === savedFor; } catch { return false; }
  }

  async function connect(uid, password) {
    graderOrigin();
    const c = new GraderClient(cfg().get('rootUrl'));
    await c.login(uid, password);
    client = c;
  }

  async function ensureClient() {
    if (client) return client;
    const uid = await context.secrets.get('nattee.uid');
    const pw = await context.secrets.get('nattee.password');
    if (!uid || !pw) throw new Error('Not signed in. Run "Nattee: Sign In".');
    // Sign-ins from before the origin was saved were for the default grader.
    const savedFor = (await context.secrets.get('nattee.origin')) || DEFAULT_ORIGIN;
    if (graderOrigin() !== savedFor) {
      throw new Error(`Not signed in to ${graderOrigin()} (your saved sign-in is for ${savedFor}). Run "Nattee: Sign In".`);
    }
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

  // A running mock exam: { started, deadline, minutes, items: [{ id, code, file }] }, kept across restarts.
  const mock = () => context.globalState.get('nattee.mock');
  const inMock = () => !!mock();
  const refuseInMock = (what) => {
    if (inMock()) throw new Error(`Mock exam in progress: ${what} until you hand in. Use "Run in Terminal" to try your own input.`);
  };

  // --------------------------------------------------------------- problems
  const cachedProblemsFile = () => path.join(cacheRoot(), 'problems.json');

  function loadCachedProblems() {
    try { problems = JSON.parse(fs.readFileSync(cachedProblemsFile(), 'utf8')); } catch { problems = []; }
  }

  // Every problem is listed, exam practice too, also those without test cases (statement + submit only).
  async function refreshProblems() {
    problems = await withClient((c) => c.listProblems());
    fs.mkdirSync(cacheRoot(), { recursive: true });
    fs.writeFileSync(cachedProblemsFile(), JSON.stringify(problems));
    tree.fire();
    updateEditorState(); // the open file may only now match a problem
  }

  // false only when the grader says so; problems cached by older versions all had tests
  const hasTests = (p) => p.hasTestcases !== false;

  const groupOf = (p) => chapterOf(p.code);

  class ProblemTree {
    constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; }
    fire() { this._e.fire(); }
    getTreeItem(el) { return el; }
    getChildren(el) {
      if (!el) {
        const groups = [...new Set(problems.map(groupOf))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); // Exam2 before Exam10
        return groups.map((g) => {
          const inGroup = problems.filter((p) => groupOf(p) === g);
          const item = new vscode.TreeItem(g, vscode.TreeItemCollapsibleState.Collapsed);
          item.groupKey = g;
          item.description = `${inGroup.filter((p) => p.status === 'solved').length}/${inGroup.length} solved`;
          item.iconPath = new vscode.ThemeIcon('folder');
          return item;
        });
      }
      return problems.filter((p) => groupOf(p) === el.groupKey).sort((a, b) => a.code.localeCompare(b.code)).map((p) => {
        const item = new vscode.TreeItem(p.code, vscode.TreeItemCollapsibleState.None);
        // Exam problems' names repeat the code: then show only what adds something.
        const title = p.name === p.code ? '' : p.name.replace(/^\d+_[A-Za-z]+_/, '').replace(/_/g, ' ');
        item.description = [title, !hasTests(p) && 'no tests', p.status === 'inprogress' && p.score]
          .filter((x) => x || x === 0).join(' · ');
        item.tooltip = `${p.code}\n${p.name}\n${p.status || 'untried'}${p.status && p.status !== 'untried' ? ` (best score ${p.score})` : ''}`
          + (hasTests(p) ? '' : '\nNo test cases on the grader: try your own input (Run One Test) or submit to check it.');
        item.contextValue = 'problem';
        item.problem = p;
        item.iconPath = p.status === 'solved' ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
          : p.status === 'inprogress' ? new vscode.ThemeIcon('circle-large-filled', new vscode.ThemeColor('list.warningForeground'))
            : new vscode.ThemeIcon('circle-large-outline');
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
    if (!hasTests(p)) return [];
    // v2: read from the test case page, with data files. Older tests.json caches (which could hold a grader
    // web page instead of the test) are simply ignored.
    const file = path.join(problemDir(p.id), 'tests.v2.json');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }
    const cases = await withClient((c) => c.fetchTestcases(p.id));
    fs.mkdirSync(problemDir(p.id), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cases));
    return cases;
  }

  let statementPanel = null;
  let shownProblem = null;

  // preserveFocus true = opened automatically (switching to a linked file); false = the user asked for it.
  async function showStatement(p, preserveFocus = true) {
    if (shownProblem === p.id && statementPanel) { statementPanel.reveal(vscode.ViewColumn.Beside, preserveFocus); return; }
    if (shownProblem === p.id && preserveFocus) return; // a non-PDF statement already opened beside the code
    const file = await getStatement(p);
    if (path.extname(file) !== '.pdf') {
      // Not a PDF (HTML, text, ...): open it beside the code like the PDF viewer, without taking focus.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preserveFocus, preview: true });
      shownProblem = p.id;
      return;
    }
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
  // Explicit link first; otherwise a solution file named after a problem code (05_List_15.py) links itself.
  // Only source files: notes or inputs such as 05_List_15_input.txt must not get Run/Submit.
  const SOURCE_EXTS = ['.py', '.cpp', '.c'];
  const linkedProblem = (file) => {
    const id = links()[linkKey(file)];
    const explicit = id && problems.find((p) => p.id === id);
    if (explicit) return explicit;
    if (!SOURCE_EXTS.includes(path.extname(file).toLowerCase())) return undefined;
    const stem = path.basename(file, path.extname(file));
    return problems.find((p) => {
      const code = safeName(p.code);
      return stem.startsWith(code) && !/^\d/.test(stem.slice(code.length));
    });
  };
  const setLink = (file, id) => {
    const run = lastRun.get(linkKey(file));
    if (run && run.problemId !== id) lastRun.delete(linkKey(file)); // those results were for another problem
    return context.globalState.update('nattee.links', { ...links(), [linkKey(file)]: id });
  };

  function updateEditorState() {
    const ed = vscode.window.activeTextEditor;
    const p = ed && ed.document.uri.scheme === 'file' ? linkedProblem(ed.document.fileName) : null;
    vscode.commands.executeCommand('setContext', 'nattee.activeFileLinked', !!p);
    if (p) {
      // Without grader tests (none for this problem, or a mock exam is running) it runs your own input instead.
      status.text = inMock() ? `$(terminal) Run ${p.code} in terminal` : hasTests(p) ? `$(play) Run ${p.code}` : `$(play) Try ${p.code} (no tests)`;
      status.command = inMock() ? 'nattee.runInTerminal' : hasTests(p) ? 'nattee.runTests' : 'nattee.runOneTest';
      status.show();
    } else status.hide();
    updateFailureContext();
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
  let resultsHtml = emptyHtml();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('nattee.results', {
    resolveWebviewView(view) {
      resultsView = view;
      view.webview.html = resultsHtml;
      view.onDidDispose(() => { resultsView = null; });
    },
  }));

  function showView(html, description) {
    resultsHtml = html;
    if (resultsView) {
      resultsView.webview.html = html;
      resultsView.description = description;
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
    await context.secrets.store('nattee.origin', graderOrigin());
    await setLoggedIn(true);
    await refreshProblems();
    vscode.window.showInformationMessage(`Nattee: signed in, ${problems.length} problems loaded.`);
  });

  reg('nattee.logout', async () => {
    client = null; problems = [];
    await context.secrets.delete('nattee.uid');
    await context.secrets.delete('nattee.password');
    await context.secrets.delete('nattee.origin');
    await setLoggedIn(false);
    tree.fire();
    updateEditorState();
  });

  reg('nattee.refresh', refreshProblems);

  reg('nattee.clearCache', async () => {
    fs.rmSync(cacheRoot(), { recursive: true, force: true });
    problems = [];
    tree.fire();
    updateEditorState();
    if (client || await context.secrets.get('nattee.uid')) await refreshProblems();
    vscode.window.showInformationMessage('Nattee: cache cleared, statements and test cases will be downloaded again.');
  });

  // Runs fn on every problem, three at a time so the grader isn't flooded, with a progress bar that can be
  // cancelled. -> { saved, failed: [codes], stopped }
  async function eachProblem(title, list, fn) {
    const queue = [...list];
    const failed = [];
    let done = 0;
    let stopped = false;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const worker = async () => {
        while (queue.length) {
          if (token.isCancellationRequested) { stopped = true; return; }
          const p = queue.shift();
          try { await fn(p); } catch { failed.push(p.code); }
          done++;
          progress.report({ message: `${done} of ${list.length}`, increment: 100 / list.length });
        }
      };
      await Promise.all([1, 2, 3].map(worker));
    });
    return { saved: done - failed.length, failed, stopped };
  }
  const someOf = (codes) => codes.slice(0, 5).join(', ') + (codes.length > 5 ? ` and ${codes.length - 5} more` : '');

  // Saves every problem's statement and tests, so all but Submit works while the grader site is down.
  // Only what isn't saved yet is downloaded.
  reg('nattee.downloadAll', async () => {
    await refreshProblems();
    const all = [...problems];
    const r = await eachProblem('Nattee: saving problems for offline use', all, async (p) => { await getStatement(p); await getTests(p); });
    if (r.stopped) {
      vscode.window.showInformationMessage(`Nattee: stopped. ${r.saved} of ${all.length} problems saved - press Download All again for the rest.`);
    } else if (r.failed.length) {
      vscode.window.showWarningMessage(`Nattee: saved ${r.saved} of ${all.length} problems for offline use. Couldn't download ${someOf(r.failed)} - press Download All again to retry.`);
    } else {
      vscode.window.showInformationMessage(`Nattee: all ${all.length} problems saved. Everything except Submit now works without the grader site.`);
    }
  });

  const downloadsDir = () => {
    const d = path.join(os.homedir(), 'Downloads');
    return fs.existsSync(d) ? d : os.homedir();
  };
  const languageExt = (lang) => (/python/i.test(lang) ? '.py' : /c\+\+|cpp/i.test(lang) ? '.cpp' : /^\s*c\s*$/i.test(lang) ? '.c' : '.txt');

  // Every statement, and your latest submitted code for each problem, into one new folder. Command Palette only.
  reg('nattee.exportAll', async () => {
    await refreshProblems();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(downloadsDir()),
      openLabel: 'Save here', title: 'Nattee: where should the statements and your solutions go?',
    });
    if (!picked || !picked.length) return;
    // a new folder each time, so nothing already there is overwritten
    const day = stamp(new Date()).slice(0, 10);
    let dir = path.join(picked[0].fsPath, EXPORT_PREFIX + day);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(picked[0].fsPath, `${EXPORT_PREFIX}${day}-${n}`);
    const all = [...problems];
    let solutions = 0;
    const r = await eachProblem('Nattee: downloading all statements and your solutions', all, async (p) => {
      const into = path.join(dir, safeName(groupOf(p)));
      fs.mkdirSync(into, { recursive: true });
      const statement = await getStatement(p);
      fs.copyFileSync(statement, path.join(into, `${safeName(p.code)}${path.extname(statement)}`));
      if (!p.lastSubmissionId) return; // never submitted
      const { source, language } = await withClient((c) => c.fetchSubmissionSource(p.lastSubmissionId));
      fs.writeFileSync(path.join(into, `${safeName(p.code)}${languageExt(language)}`), source);
      solutions++;
    });
    const what = `${r.saved} of ${all.length} problems (${solutions} with your latest submitted code)`;
    let answer;
    if (r.stopped) answer = await vscode.window.showInformationMessage(`Nattee: stopped after ${what}. Folder: ${dir}`, 'Open Folder');
    else if (r.failed.length) answer = await vscode.window.showWarningMessage(`Nattee: saved ${what}. Couldn't download ${someOf(r.failed)}. Folder: ${dir}`, 'Open Folder');
    else answer = await vscode.window.showInformationMessage(`Nattee: saved all ${all.length} statements and ${solutions} solutions (your latest submission of each). Folder: ${dir}`, 'Open Folder');
    if (answer === 'Open Folder') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  });

  // ------------------------------------------------------ statement buttons
  // Asks the statement viewer, which has the PDF open in pdf.js: 'getText' -> { pages: [text of each page] },
  // 'getImage' -> { png: data URL of every page as one picture }. The text is asked again every 2 s in case the
  // viewer is still loading; the picture is only asked for once the text has come, so the viewer is ready.
  let viewerRequests = 0;
  function askViewer(type) {
    const panel = statementPanel;
    const id = ++viewerRequests;
    const reply = type === 'getText' ? 'text' : 'image';
    return new Promise((resolve, reject) => {
      const ask = () => panel.webview.postMessage({ type, id });
      const retry = type === 'getText' ? setInterval(ask, 2000) : null;
      const giveUp = setTimeout(() => done(new Error("the statement viewer didn't answer - try again once the statement is showing")), 30000);
      const sub = panel.webview.onDidReceiveMessage((m) => {
        if (m && m.type === reply && m.id === id) done(m.error ? new Error(`couldn't read the statement (${m.error})`) : null, m);
      });
      function done(err, m) { clearInterval(retry); clearTimeout(giveUp); sub.dispose(); if (err) reject(err); else resolve(m); }
      ask();
    });
  }
  const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // a page with (almost) no text has its words drawn as shapes or a scan: only a picture of it has them
  const drawnPage = (text) => text.replace(/\s/g, '').length < 20;

  // Whose statement: the viewer's when it is the active tab (its title-bar buttons), else the current file's
  // problem, else the one shown last.
  function statementProblem() {
    const shown = problems.find((p) => p.id === shownProblem);
    if (shown && statementPanel && statementPanel.active) return shown;
    const ed = vscode.window.activeTextEditor;
    const p = (ed && ed.document.uri.scheme === 'file' && linkedProblem(ed.document.fileName)) || shown;
    if (!p) throw new Error("Open a problem's statement first (click the problem in the sidebar).");
    return p;
  }

  // Copies the statement to paste into a chat, an AI or notes: as text, or as a picture when part of it is drawn
  // rather than written (some PDFs have their words as shapes, which have no text to copy).
  reg('nattee.copyStatement', async () => {
    refuseInMock('copying the statement is off');
    const p = statementProblem();
    const file = await getStatement(p);
    if (path.extname(file).toLowerCase() !== '.pdf') {
      let text = fs.readFileSync(file, 'utf8');
      if (/\.html?$/i.test(file)) text = decodeEntities(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' '));
      await vscode.env.clipboard.writeText(`${p.code}\n\n${tidy(text)}\n`);
      vscode.window.showInformationMessage(`Nattee: ${p.code}'s statement copied - paste it anywhere.`);
      return;
    }
    await showStatement(p, true);
    const { pages } = await askViewer('getText');
    const text = tidy(pages.join('\n\n'));
    if (!pages.some(drawnPage)) {
      await vscode.env.clipboard.writeText(`${p.code}\n\n${text}\n`);
      vscode.window.showInformationMessage(`Nattee: ${p.code}'s statement copied - paste it anywhere.`);
      return;
    }
    try {
      const { png } = await askViewer('getImage');
      await copyPngToClipboard(Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
      // a picture of many pages has them small (apps shrink big pictures), the PDF has them sharp
      const long = pages.length > 6 ? ` It's ${pages.length} pages, so they're small in it: if they can't be read, use Save Statement As... and attach the PDF.` : '';
      vscode.window.showInformationMessage(`Nattee: ${p.code}'s statement copied as a picture (part of it isn't text) - paste it into a chat or an AI.${long}`);
    } catch (e) {
      if (text) await vscode.env.clipboard.writeText(`${p.code}\n\n${text}\n`);
      vscode.window.showWarningMessage(`Nattee: part of ${p.code}'s statement isn't text and couldn't be copied as a picture (${e.message}). `
        + `${text ? 'The rest was copied. ' : ''}Use Save Statement As... and attach the PDF instead.`);
    }
  });

  // Saves a copy of the statement (the PDF) wherever you like, e.g. to attach it to a chat.
  reg('nattee.saveStatement', async () => {
    const p = statementProblem();
    const file = await getStatement(p);
    const ext = path.extname(file);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(downloadsDir(), `${safeName(p.code)}${ext}`)), saveLabel: 'Save statement',
      filters: ext.toLowerCase() === '.pdf' ? { PDF: ['pdf'] } : undefined,
    });
    if (!target) return;
    fs.copyFileSync(file, target.fsPath);
    if (await vscode.window.showInformationMessage(`Nattee: saved ${path.basename(target.fsPath)}.`, 'Show in Folder') === 'Show in Folder') {
      vscode.commands.executeCommand('revealFileInOS', target);
    }
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('nattee.rootUrl')) return;
    client = null; loadCachedProblems(); tree.fire(); updateEditorState();
    // Sign in again automatically only on the grader the saved password belongs to.
    signedInHere().then(async (ok) => {
      await setLoggedIn(ok);
      if (ok) await refreshProblems();
    }).catch(fail);
  }));

  reg('nattee.openProblem', async (item) => {
    const p = item && item.problem ? item.problem : await pickProblem();
    if (p) await showStatement(p, false);
  });

  // The workspace folder new files go in: the active file's, else the first one.
  function workspaceFolder() {
    const ed = vscode.window.activeTextEditor;
    const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri))
      || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    if (!folder) throw new Error('Open a folder in VS Code first (File > Open Folder), for your solution files.');
    return folder;
  }
  const solutionExt = () => { const ext = cfg().get('defaultExtension') || '.py'; return ext.startsWith('.') ? ext : '.' + ext; };
  const MOCK_DIR = 'mock-exams';
  const EXPORT_PREFIX = 'nattee-export-'; // folders made by "Download All Statements and My Solutions"

  reg('nattee.createSolution', async (item) => {
    const p = item && item.problem ? item.problem : await pickProblem();
    if (!p) return;
    const folder = workspaceFolder();
    const ext = solutionExt();
    // Reuse a solution already in the workspace (any folder) rather than making a second copy. Mock exam answers
    // don't count: they are separate attempts.
    const [existing] = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${safeName(p.code)}${ext}`), `**/{node_modules,.git,${MOCK_DIR},${EXPORT_PREFIX}*}/**`, 1);
    const file = existing ? existing.fsPath : solutionPath(folder.uri.fsPath, p.code, ext, cfg().get('organizeByChapter'));
    const rel = path.relative(folder.uri.fsPath, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to create ${file}: it is outside the workspace folder.`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
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

  const runCfg = () => ({
    pythonPath: cfg().get('pythonPath'), cppCompiler: cfg().get('cppCompiler'), cCompiler: cfg().get('cCompiler'),
    timeoutMs: cfg().get('timeLimitSeconds') * 1000,
  });
  // file -> { problemId, source, cases, results } of the last full run, for submit's note and AI Explain.
  const lastRun = new Map();
  // The last run of this file, if it was for this problem.
  const lastRunFor = (file, p) => { const run = lastRun.get(linkKey(file)); return run && p && run.problemId === p.id ? run : null; };
  const isFailure = (r) => r.verdict !== 'PASS' && r.verdict !== 'SKIP';
  const tally = (results) => {
    const skipped = results.filter((r) => r.verdict === 'SKIP').length;
    const passed = results.filter((r) => r.verdict === 'PASS').length;
    return { passed, ran: results.length - skipped, text: `${passed}/${results.length - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}` };
  };

  function updateFailureContext() {
    const ed = vscode.window.activeTextEditor;
    const run = ed && lastRunFor(ed.document.fileName, linkedProblem(ed.document.fileName));
    vscode.commands.executeCommand('setContext', 'nattee.hasFailure', !!run && run.results.some(isFailure));
  }

  // One test run at a time. A save while tests run queues one more automatic run afterwards, so the newest
  // code always gets tested. Saves the extension makes itself (before a run or submit) don't start a run.
  let running = false, rerunQueued = false, ownSave = false;
  async function saveQuietly(doc) {
    ownSave = true;
    try { await doc.save(); } finally { ownSave = false; }
  }

  async function runActive(auto) {
    if (running) {
      if (auto) rerunQueued = true; else vscode.window.showInformationMessage('Nattee: tests are already running.');
      return;
    }
    running = true;
    try {
      await runActiveNow(auto);
    } finally {
      running = false;
      if (rerunQueued) { rerunQueued = false; runActive(true).catch(fail); }
    }
  }

  async function runActiveNow(auto) {
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
    if (!hasTests(p)) {
      if (!auto) vscode.window.showInformationMessage(`${p.code} has no test cases on the grader. Use Run One Test with your own input, or submit to check it.`);
      return;
    }
    await saveQuietly(ed.document);
    const source = ed.document.getText(); // the code being tested, before any edits made while it runs
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running ${p.code}...` }, async () => {
      const cases = await getTests(p);
      let results;
      try {
        results = await runTests(ed.document.fileName, cases, runCfg());
      } catch (e) {
        if (e.details) { vscode.window.showErrorMessage(`Nattee: ${e.message}\n${e.details.slice(0, 400)}`); return; }
        throw e;
      }
      const t = tally(results);
      lastRun.set(linkKey(ed.document.fileName), { problemId: p.id, source, cases, results });
      updateFailureContext();
      showView(localResultsHtml(p, cases, results), `${p.code}: ${t.passed}/${t.ran}`);
      (t.passed === t.ran ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(
        `${p.code}: ${t.text.replace('passed', 'tests passed')}`);
    });
  }

  reg('nattee.runTests', () => { refuseInMock("the grader's tests are off"); return runActive(false); });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    const ed = vscode.window.activeTextEditor;
    if (ownSave || inMock() || !cfg().get('runOnSave') || !ed || ed.document !== doc || !linkedProblem(doc.fileName)) return;
    runActive(true).catch(fail);
  }));

  // Run one chosen test, or your own input, and show the output.
  reg('nattee.runOneTest', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    const p = linkedProblem(ed.document.fileName);
    const allCases = p ? await getTests(p) : [];
    const cases = inMock() ? [] : allCases; // the grader's tests are hidden during a mock exam
    const items = [
      ...cases.map((c, i) => ({ label: `Test ${i + 1}`, description: c.input.split('\n')[0].slice(0, 60), kind: 'test', i })),
      { label: '$(terminal) Type the input yourself in the terminal', description: 'line by line, like in Thonny', kind: 'terminal' },
      { label: '$(edit) Custom input in one line', description: 'write \\n for a new line', kind: 'typed' },
      { label: '$(clippy) Custom input from the clipboard', kind: 'clipboard' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Which input to run?' });
    if (!pick) return;
    if (pick.kind === 'terminal') return vscode.commands.executeCommand('nattee.runInTerminal');
    let input, expected, title;
    if (pick.kind === 'test') {
      const tc = cases[pick.i];
      if (tc.partialInput) throw new Error(`The grader only shows the start of test ${pick.i + 1}'s input, so it can't be run here.`);
      input = tc.input; title = `${p.code} test ${pick.i + 1}`;
      if (tc.partialOutput) title += ' (expected output too long to check here)'; else expected = tc.output;
    } else if (pick.kind === 'clipboard') {
      input = await vscode.env.clipboard.readText(); title = 'Custom input (clipboard)';
    } else {
      const typed = await vscode.window.showInputBox({ prompt: 'Input for your program (write \\n for a new line)', ignoreFocusOut: true });
      if (typed === undefined) return;
      input = typed.replace(/\\n/g, '\n'); title = 'Custom input';
    }
    if (!input.endsWith('\n')) input += '\n';
    await saveQuietly(ed.document);
    const files = allCases.length ? allCases[0].files : undefined; // so custom input can name /data/... files too
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Running...' },
      () => runSingle(ed.document.fileName, input, runCfg(), files));
    showView(singleResultHtml(title, input, expected, r), title);
  });

  // Sends the file to the real grader. Always asks first; never runs on save.
  reg('nattee.submit', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    const p = linkedProblem(ed.document.fileName);
    if (!p) throw new Error('This file is not linked to a problem. Use "Nattee: Link Current File to Problem".');
    refuseInMock('submitting is off');
    await saveQuietly(ed.document);
    const source = ed.document.getText();
    if (!source.trim()) throw new Error('The file is empty.');
    await refreshProblems(); // also makes sure the session is still valid before we send anything
    const local = lastRunFor(ed.document.fileName, p);
    const localNote = !hasTests(p) ? 'This problem has no test cases to run locally.'
      : !local || local.source !== source ? 'Local tests have not been run on this version.'
      : `Local tests: ${tally(local.results).text}.`;
    const choice = await vscode.window.showWarningMessage(
      `Submit ${path.basename(ed.document.fileName)} to the grader for ${p.code}?`,
      { modal: true, detail: `${localNote}\nThis sends your code to ${new URL(cfg().get('rootUrl')).host} and counts as an attempt.` },
      'Submit');
    if (choice !== 'Submit') return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Submitting ${p.code}...` }, async () => {
      const c = await ensureClient();
      const { id } = await c.submit(p.id, source, path.extname(ed.document.fileName));
      const show = (g) => showView(submissionHtml(p, id, g), `${p.code}: submitted #${id}`);
      show({ tests: [], status: 'queued', done: false });
      const grade = await c.waitForGrade(id, { onUpdate: show });
      show(grade);
      await refreshProblems();
      const msg = grade.timedOut ? `${p.code}: submitted #${id}, still grading - check the grader site.`
        : `${p.code}: ${grade.points}/${grade.max} points (submission #${id})`;
      (grade.points === grade.max ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(msg);
    });
  });

  // ------------------------------------------------------------- AI explain
  const KEY_PROMPT = 'Gemini API key (free from aistudio.google.com) - used only for AI explanations, kept in VS Code\'s secret storage';

  async function ensureGeminiKey() {
    let key = await context.secrets.get('nattee.geminiApiKey');
    if (key) return key;
    key = await vscode.window.showInputBox({ prompt: KEY_PROMPT, password: true, ignoreFocusOut: true });
    if (!key) return null;
    await context.secrets.store('nattee.geminiApiKey', key);
    return key;
  }

  reg('nattee.setApiKey', async () => {
    const key = await vscode.window.showInputBox({ prompt: KEY_PROMPT, password: true, ignoreFocusOut: true });
    if (!key) return;
    await context.secrets.store('nattee.geminiApiKey', key);
    vscode.window.showInformationMessage('Nattee: Gemini API key saved.');
  });

  reg('nattee.clearApiKey', async () => {
    await context.secrets.delete('nattee.geminiApiKey');
    vscode.window.showInformationMessage('Nattee: Gemini API key removed.');
  });

  // Explains the failing tests of the last run with Gemini, using the student's own API key.
  // Sends the first few failures together (they usually share one bug), so there's nothing to
  // pick. Only runs when this command is invoked, never automatically.
  reg('nattee.explainFailure', async () => {
    refuseInMock('the AI is off');
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    const p = linkedProblem(ed.document.fileName);
    const run = lastRunFor(ed.document.fileName, p);
    const failing = run ? run.results.map((r, i) => ({ r, i })).filter((x) => isFailure(x.r)) : [];
    if (!failing.length) throw new Error('No failing test to explain. Run the tests first (▶) - if they all pass, there is nothing to explain.');

    const apiKey = await ensureGeminiKey();
    if (!apiKey) return;

    const stale = run.source !== ed.document.getText();
    const context_ = {
      code: run.source,
      language: path.extname(ed.document.fileName).slice(1) || 'text',
      problem: p,
      totalFailing: failing.length,
      dataFiles: run.cases[0] && run.cases[0].files,
      failures: failing.slice(0, MAX_FAILURES).map(({ r, i }) => ({
        n: i + 1, testInput: run.cases[i].input, expected: run.cases[i].output,
        partialOutput: !!run.cases[i].partialOutput, actual: r.stdout, stderr: r.stderr, verdict: r.verdict,
      })),
    };
    const shown = context_.failures.map((f) => f.n);
    const model = cfg().get('geminiModel');
    const { text, model: answeredBy, fallback } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Asking Gemini why test${shown.length > 1 ? 's' : ''} ${shown.join(', ')} fail${shown.length > 1 ? '' : 's'}...` },
      () => explainFailures(apiKey, [model, cfg().get('geminiFallbackModel')], context_));
    const more = failing.length > shown.length ? ` (${failing.length} failing, first ${shown.length} sent)` : '';
    const title = `${p ? p.code + ' — ' : ''}Test${shown.length > 1 ? 's' : ''} ${shown.join(', ')} explained${more}`;
    const notes = [];
    if (stale) notes.push('Note: you have edited the file since the tests ran - the explanation is for the version you last ran.');
    if (fallback) notes.push(`${model} was overloaded, so ${answeredBy} answered instead.`);
    showView(explanationHtml(title, notes.join(' ') || null, text), `AI explanation (${answeredBy})`);
  });

  // -------------------------------------------------------- run in terminal
  // Runs the file in VS Code's terminal, so the student types the input line by line, like in Thonny's shell.
  // The extension starts the program itself (no shell, so no quoting problems on any OS) and keeps the terminal
  // open when it ends, so its output and any error stay on screen.
  const runTerminals = new Map(); // file -> its Run in Terminal terminal
  reg('nattee.runInTerminal', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') throw new Error('Open a solution file first.');
    const file = ed.document.fileName;
    if (!SOURCE_EXTS.includes(path.extname(file).toLowerCase())) throw new Error('Run in Terminal works for .py, .cpp and .c files.');
    await saveQuietly(ed.document);
    const p = linkedProblem(file);
    // The problem's data files (e.g. /data/data.txt) come with the test cases; the real exam has them too.
    const files = p && hasTests(p) ? ((await getTests(p))[0] || {}).files : undefined;
    let prep;
    try {
      prep = await terminalCommand(file, runCfg());
    } catch (e) {
      if (e.details) { vscode.window.showErrorMessage(`Nattee: ${e.message}\n${e.details.slice(0, 400)}`); return; }
      throw e;
    }
    let box = null;
    try { box = dataSandbox(files); } catch (e) { prep.cleanup(); throw e; }
    // Running again replaces the last run of this file (stopping it if it is still waiting for input).
    if (runTerminals.has(file)) runTerminals.get(file).dispose();
    const dataName = box && Object.keys(files)[0];
    const term = vscode.window.createTerminal({
      name: `Run ${path.basename(file)}`,
      pty: programTerminal({
        cmd: prep.cmd, args: prep.args, cwd: box ? box.dir : path.dirname(file), kill: killTree,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
        intro: `Running ${path.basename(file)}: type the input and press Enter. Ctrl+C stops it.`
          + (dataName ? `\nThis problem's data files are here: where it says /data/${dataName}, type data/${dataName}.` : ''),
        onExit: () => { prep.cleanup(); if (box) box.cleanup(); },
      }),
    });
    runTerminals.set(file, term);
    term.show();
  });
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => {
    for (const [f, x] of runTerminals) if (x === t) runTerminals.delete(f);
  }));

  // -------------------------------------------------------------- mock exam
  // A timed practice exam from the grader's problems. Until hand-in it is like the real exam (Thonny, no grader):
  // no tests, no AI, no submit, only running your own input. At hand-in every answer is marked with the tests.
  const mockStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  mockStatus.command = 'nattee.handInMockExam';
  mockStatus.tooltip = 'Hand in the mock exam now';
  context.subscriptions.push(mockStatus);
  let mockTimer = null, handingIn = false, warned = false;

  function startMockUi() {
    vscode.commands.executeCommand('setContext', 'nattee.mockExam', true);
    const tick = () => {
      const m = mock();
      if (!m) { stopMockUi(); return; }
      const left = m.deadline - Date.now();
      if (left <= 0) { stopMockUi(); handIn(true).catch(fail); return; }
      if (left <= 5 * 60000 && !warned) {
        warned = true;
        vscode.window.showWarningMessage('Nattee: 5 minutes left in your mock exam.');
      }
      mockStatus.text = `$(watch) ${clock(left)} left · Hand in`;
      mockStatus.show();
    };
    clearInterval(mockTimer);
    warned = false;
    tick();
    mockTimer = setInterval(tick, 1000);
    if (mockTimer.unref) mockTimer.unref();
    updateEditorState();
  }

  function stopMockUi() {
    clearInterval(mockTimer);
    mockTimer = null;
    mockStatus.hide();
    vscode.commands.executeCommand('setContext', 'nattee.mockExam', false);
  }

  reg('nattee.startMockExam', async () => {
    if (inMock()) throw new Error('A mock exam is already running. Hand it in first ("Nattee: Hand In Mock Exam").');
    const folder = workspaceFolder();
    if (!problems.length) await refreshProblems();
    const groups = [...new Set(problems.filter(hasTests).map(groupOf))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!groups.length) throw new Error('There are no problems with test cases to make a mock exam from.');
    const chosenGroups = await vscode.window.showQuickPick(groups.map((g) => ({ label: g, picked: /^Exam/.test(g) })),
      { canPickMany: true, placeHolder: 'Mock exam: take problems from which chapters or exams?', ignoreFocusOut: true });
    if (!chosenGroups || !chosenGroups.length) return;
    const count = await vscode.window.showQuickPick([1, 2, 3, 4, 5].map((n) => ({ label: `${n} problem${n > 1 ? 's' : ''}`, n })),
      { placeHolder: 'How many problems?', ignoreFocusOut: true });
    if (!count) return;
    const time = await vscode.window.showQuickPick([30, 60, 90, 120, 150].map((m) => ({ label: `${m} minutes`, m })),
      { placeHolder: 'How long? (Exam 1 was 150 minutes for 4 problems)', ignoreFocusOut: true });
    if (!time) return;
    const chosen = pickProblems(problems, chosenGroups.map((g) => g.label), count.n, groupOf);
    if (!chosen.length) throw new Error('No problems with test cases in those groups.');
    // Statements and tests are downloaded now, so a network or grader problem shows up before the clock starts.
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing your mock exam...' },
      () => Promise.all(chosen.map((p) => Promise.all([getStatement(p), getTests(p)])))).catch((e) => {
      throw new Error(`couldn't get the mock exam's problems (${e.message}). Tip: press Download All for Offline while the grader site is up, then mocks work without it.`);
    });
    let dir = path.join(folder.uri.fsPath, MOCK_DIR, stamp(new Date()));
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(folder.uri.fsPath, MOCK_DIR, `${stamp(new Date())}-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const items = [];
    for (const p of chosen) {
      const file = path.join(dir, `${safeName(p.code)}${solutionExt()}`);
      fs.writeFileSync(file, '');
      await setLink(file, p.id);
      items.push({ id: p.id, code: p.code, file });
    }
    const now = Date.now();
    await context.globalState.update('nattee.mock', { started: now, deadline: now + time.m * 60000, minutes: time.m, items });
    startMockUi();
    for (const it of [...items].reverse()) await vscode.window.showTextDocument(vscode.Uri.file(it.file), { preview: false });
    updateEditorState();
    await showStatement(chosen[0]);
    vscode.window.showInformationMessage(`Nattee: mock exam started - ${items.length} problem${items.length > 1 ? 's' : ''}, ${time.m} minutes. `
      + 'Tests, AI and submit are off until you hand in; use Run in Terminal to try your own input. Click the timer to hand in early.');
  });

  // Marks every answer with the grader's tests, shows the report and turns the help back on.
  // auto: the time ran out (no question asked).
  async function handIn(auto) {
    const m = mock();
    if (!m) throw new Error('No mock exam is running.');
    if (!auto) {
      const choice = await vscode.window.showWarningMessage('Hand in your mock exam now?',
        { modal: true, detail: `${clock(m.deadline - Date.now())} left. Your answers will be marked with the grader's tests.` }, 'Hand In');
      if (choice !== 'Hand In') return;
    }
    if (handingIn) return;
    handingIn = true;
    try {
      stopMockUi();
      await context.globalState.update('nattee.mock', undefined);
      const mine = (f) => m.items.some((it) => linkKey(it.file) === linkKey(f));
      for (const doc of vscode.workspace.textDocuments || []) if (doc.isDirty && mine(doc.fileName)) await saveQuietly(doc);
      const minutesUsed = Math.max(1, Math.round((Math.min(Date.now(), m.deadline) - m.started) / 60000));
      const marked = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Marking your mock exam...' }, async () => {
        const out = [];
        for (const it of m.items) {
          const p = problems.find((x) => x.id === it.id) || { id: it.id, code: it.code, name: it.code };
          let source = '';
          try { source = fs.readFileSync(it.file, 'utf8'); } catch { /* deleted */ }
          if (!source.trim()) { out.push({ code: it.code, note: 'Not attempted' }); continue; }
          try {
            const cases = await getTests(p);
            const results = await runTests(it.file, cases, runCfg());
            lastRun.set(linkKey(it.file), { problemId: p.id, source, cases, results });
            out.push({ code: it.code, cases, results });
          } catch (e) {
            out.push({ code: it.code, note: e.details ? `${e.message}: ${e.details.split('\n')[0]}` : e.message });
          }
        }
        return out;
      });
      const summary = summarize(marked);
      const history = [...context.globalState.get('nattee.mockHistory', []),
        { date: Date.now(), percent: summary.percent, codes: m.items.map((it) => it.code), minutesUsed, minutes: m.minutes }].slice(-20);
      await context.globalState.update('nattee.mockHistory', history);
      showView(mockReportHtml(summary, { minutesUsed, minutes: m.minutes, history }), `Mock exam: ${summary.percent}%`);
      updateEditorState();
      vscode.window.showInformationMessage(`Nattee: ${auto ? 'time is up. ' : ''}Mock exam marked: ${summary.percent}%. `
        + 'Tests and AI are back on, so you can look at what went wrong.');
    } finally {
      handingIn = false;
    }
  }

  reg('nattee.handInMockExam', () => handIn(false));

  // ------------------------------------------------------------------ start
  loadCachedProblems();
  updateEditorState();
  if (inMock()) {
    // VS Code was closed during a mock: carry on, or mark it if the time ran out meanwhile.
    if (mock().deadline <= Date.now()) handIn(true).catch(fail); else startMockUi();
  }
  signedInHere().then(async (ok) => {
    await setLoggedIn(ok);
    // keeps the solved/score marks current; if that fails, say so instead of quietly showing an old list
    if (ok) {
      refreshProblems().catch((e) => vscode.window.showWarningMessage(
        `Nattee: couldn't load the problem list (${e.message}). Showing the last saved list - press Refresh to try again.`));
    }
    updateEditorState();
    tree.fire();
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
