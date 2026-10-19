'use strict';
// Loads extension.js with a fake 'vscode' module, a fake grader client and a fake runner, so activation,
// commands and events can be tested in plain Node. No network, nothing is ever submitted.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.join(__dirname, '..');

function loadExtension(opts = {}) {
  const events = { save: [], editor: [], config: [] };
  const log = {
    errors: [], warnings: [], infos: [], executed: [], logins: [], runs: [], opened: [], submitted: [], fetchedTests: [],
    statusItems: [], terminals: [], pickItems: [], picks: [], findFiles: [], cleanups: 0, progress: [], fetchedStatements: [],
    panels: [], posted: [], clipboard: [], clipboardPictures: [], saveDialogs: [], openDialogs: [], fetchedSources: [],
  };
  // the first status bar item is the Run button; later ones (the mock exam timer) are in statusItems
  Object.defineProperty(log, 'statusItem', { get: () => log.statusItems[0] });
  Object.defineProperty(log, 'status', { get: () => (log.statusItems[0] && log.statusItems[0].visible ? 'shown' : 'hidden') });
  const docs = [];
  const closeTerminal = [];
  // The settings' defaults from package.json, so the tests see what a fresh install sees.
  const defaults = Object.entries(require('../package.json').contributes.configuration.properties)
    .map(([k, v]) => [k.replace(/^nattee\./, ''), v.default]);
  const config = { ...Object.fromEntries(defaults), ...(opts.config || {}) };
  const commands = {};
  const context = {};
  const secrets = new Map(Object.entries(opts.secrets || {}));
  const gstate = new Map(Object.entries(opts.globalState || {}));
  class EventEmitter {
    constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; }
    fire(x) { this.l.forEach((f) => f(x)); }
  }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  const Uri = { file: (p) => ({ scheme: 'file', fsPath: p, path: p }) };
  const vscode = {
    EventEmitter, TreeItem, Uri,
    ThemeIcon: class { constructor(id) { this.id = id; } }, ThemeColor: class {},
    ViewColumn: { Beside: -2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    env: { clipboard: { readText: async () => '', writeText: async (t) => { log.clipboard.push(t); } } },
    workspace: {
      getConfiguration: () => ({ get: (k) => config[k] }),
      onDidChangeConfiguration: (f) => { events.config.push(f); return { dispose() {} }; },
      onDidSaveTextDocument: (f) => { events.save.push(f); return { dispose() {} }; },
      findFiles: async (pattern, exclude) => { log.findFiles.push({ pattern, exclude }); return []; },
      get textDocuments() { return docs; },
      getWorkspaceFolder: () => opts.folder,
      workspaceFolders: opts.folder ? [opts.folder] : undefined,
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: (f) => { events.editor.push(f); return { dispose() {} }; },
      createStatusBarItem: () => {
        const item = { text: '', visible: false, show() { item.visible = true; }, hide() { item.visible = false; }, dispose() {} };
        log.statusItems.push(item);
        return item;
      },
      createTerminal: (o) => {
        const t = {
          ...o, shown: false, disposed: false,
          show() { t.shown = true; },
          // like VS Code: closing a terminal closes its pseudoterminal, then tells the extension
          dispose() { t.disposed = true; if (t.pty) t.pty.close(); closeTerminal.forEach((f) => f(t)); },
        };
        log.terminals.push(t);
        return t;
      },
      onDidCloseTerminal: (f) => { closeTerminal.push(f); return { dispose() {} }; },
      registerTreeDataProvider: (id, t) => { log.tree = t; return { dispose() {} }; },
      // The Test Results view, resolved at once so tests can read what it shows.
      registerWebviewViewProvider: (id, provider) => {
        log.view = { webview: { html: '' }, description: '', show() {}, onDidDispose() {} };
        provider.resolveWebviewView(log.view);
        return { dispose() {} };
      },
      showErrorMessage: (m) => { log.errors.push(m); },
      showWarningMessage: async (m, o) => { log.warnings.push({ m, o }); return opts.warnAnswer; },
      showInformationMessage: (m) => { log.infos.push(m); },
      showQuickPick: async (items, o = {}) => {
        log.picks.push(o.placeHolder);
        log.pickItems.push(items);
        if (opts.pick) return opts.pick(items, o);
        return o.canPickMany ? items.filter((i) => i.picked) : items[0];
      },
      showInputBox: async (o) => (opts.input ? opts.input(o) : undefined),
      // opts.cancelAfter: the user presses Cancel after that many progress reports
      withProgress: async (o, f) => f({ report: (r) => log.progress.push(r) },
        { get isCancellationRequested() { return opts.cancelAfter != null && log.progress.length >= opts.cancelAfter; } }),
      showTextDocument: async (u) => { log.opened.push(u.fsPath); },
      // (createTerminal and onDidCloseTerminal are above)
      // The statement viewer. Asked for its text (the Copy button), it answers with opts.statementPages (each page's
      // text), like the real viewer reading the PDF; asked for a picture, with a PNG. opts.statementPages === null:
      // it never answers.
      createWebviewPanel: () => {
        const listeners = [];
        const panel = {
          active: true, reveal() {}, onDidDispose() {},
          webview: {
            html: '', asWebviewUri: (u) => u, cspSource: 'x',
            onDidReceiveMessage: (f) => { listeners.push(f); return { dispose() { listeners.splice(listeners.indexOf(f), 1); } }; },
            postMessage: async (m) => {
              log.posted.push(m);
              const pages = opts.statementPages === undefined ? ['Find the sum of two numbers.\nInput: two numbers'] : opts.statementPages;
              const answer = m.type === 'getText' ? { type: 'text', id: m.id, pages } : { type: 'image', id: m.id, png: 'data:image/png;base64,iVBORw0K' };
              if (pages !== null) setTimeout(() => [...listeners].forEach((f) => f(answer)), 5);
              return true;
            },
          },
        };
        log.panels.push(panel);
        return panel;
      },
      showSaveDialog: async (o) => { log.saveDialogs.push(o); return opts.saveTo ? Uri.file(opts.saveTo) : undefined; },
      showOpenDialog: async (o) => { log.openDialogs.push(o); return opts.openFolder ? [Uri.file(opts.openFolder)] : undefined; },
    },
    commands: {
      registerCommand: (n, f) => { commands[n] = f; return { dispose() {} }; },
      executeCommand: async (...a) => {
        log.executed.push(a);
        if (a[0] === 'setContext') context[a[1]] = a[2];
        else if (commands[a[0]]) return commands[a[0]](...a.slice(1));
      },
    },
  };

  // Route require('vscode') and the lib modules to fakes for this load.
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : realResolve.call(this, req, ...rest); };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };
  const fake = (rel, exports) => {
    const p = require.resolve(path.join(EXT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  const realRunner = require(path.join(EXT, 'lib/runner.js'));
  fake('lib/runner.js', {
    ...realRunner,
    runTests: async (file, cases) => {
      log.runs.push({ file });
      await new Promise((r) => setTimeout(r, opts.runMs || 30));
      return opts.runTests ? opts.runTests(file, cases) : cases.map(() => ({ verdict: 'PASS', ms: 1, stdout: '', stderr: '' }));
    },
    terminalCommand: async (file) => ({
      cmd: '/usr/bin/python3', args: [file], ...(opts.terminalCommand ? opts.terminalCommand(file) : {}), cleanup: () => { log.cleanups++; },
    }),
    runSingle: async (file) => {
      log.runs.push({ file, single: true });
      await new Promise((r) => setTimeout(r, opts.runMs || 30));
      return { verdict: 'OK', ms: 1, stdout: 'x', stderr: '' };
    },
  });
  const problems = opts.problems || [{ id: '1', code: '05_List_15', name: '05_List_15_Foo', hasTestcases: true, status: 'untried', score: 0 }];
  class FakeClient {
    constructor(root) { this.root = root; }
    async login(uid, pw) { log.logins.push({ root: this.root, uid, pw }); }
    async listProblems() { if (opts.listError) throw new Error(opts.listError); return problems; }
    async fetchStatement(id) {
      log.fetchedStatements.push(id);
      if ((opts.failStatements || []).includes(id)) throw new Error('HTTP 500');
      return opts.statement || { data: Buffer.from('%PDF'), ext: '.pdf' };
    }
    async fetchTestcases(id) {
      log.fetchedTests.push(id);
      if ((opts.failIds || []).includes(id)) throw new Error('HTTP 500');
      return opts.cases || [{ input: '1\n', output: '1\n' }, { input: '2\n', output: '2\n' }];
    }
    async fetchSubmissionSource(id) {
      log.fetchedSources.push(id);
      return (opts.sources || {})[id] || { source: `print(${id})\n`, language: 'Python' };
    }
    async submit(id, source) { log.submitted.push({ id, source }); return { id: '9' }; }
    async waitForGrade() { return { points: 100, max: 100, tests: [], done: true }; }
  }
  const realClient = require(path.join(EXT, 'lib/client.js'));
  fake('lib/client.js', { ...realClient, GraderClient: FakeClient });
  fake('lib/statement.js', { statementHtml: () => '<html></html>' });
  fake('lib/clipboardImage.js', {
    copyPngToClipboard: async (png) => { if (opts.pictureError) throw new Error(opts.pictureError); log.clipboardPictures.push(png); },
  });

  const extPath = require.resolve(path.join(EXT, 'extension.js'));
  delete require.cache[extPath];
  const ext = require(extPath);
  Module._resolveFilename = realResolve;

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-harness-'));
  ext.activate({
    extensionPath: EXT, subscriptions: [], globalStorageUri: { fsPath: storage },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    globalState: { get: (k, d) => (gstate.has(k) ? gstate.get(k) : d), update: async (k, v) => { gstate.set(k, v); } },
  });

  function makeDoc(fileName, text = 'print(1)') {
    const doc = {
      fileName, uri: Uri.file(fileName), text, dirty: false,
      get isDirty() { return this.dirty; },
      getText() { return this.text; },
      edit(t) { this.text = t; this.dirty = true; },
      async save() {
        if (!this.dirty) return false;
        this.dirty = false;
        if (fs.existsSync(path.dirname(fileName))) fs.writeFileSync(fileName, this.text); // a real folder in the test
        events.save.forEach((f) => f(doc));
        return true;
      },
    };
    docs.push(doc);
    return doc;
  }
  function setEditor(doc) {
    vscode.window.activeTextEditor = doc ? { document: doc } : undefined;
    events.editor.forEach((f) => f(vscode.window.activeTextEditor));
  }
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const fireConfig = (key) => events.config.forEach((f) => f({ affectsConfiguration: (k) => k === key }));
  const fireCloseTerminal = (t) => closeTerminal.forEach((f) => f(t));
  return { vscode, commands, context, log, config, secrets, gstate, makeDoc, setEditor, tick, fireConfig, fireCloseTerminal, storage };
}

module.exports = { loadExtension };
