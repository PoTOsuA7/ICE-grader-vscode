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
  const log = { errors: [], warnings: [], infos: [], executed: [], logins: [], runs: [], opened: [], submitted: [], fetchedTests: [], status: 'hidden' };
  // The settings' defaults from package.json, so the tests see what a fresh install sees.
  const defaults = Object.entries(require('../package.json').contributes.configuration.properties)
    .map(([k, v]) => [k.replace(/^nattee\./, ''), v.default]);
  const config = { ...Object.fromEntries(defaults), ...(opts.config || {}) };
  const commands = {};
  const context = {};
  const secrets = new Map(Object.entries(opts.secrets || {}));
  const gstate = new Map();
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
    env: { clipboard: { readText: async () => '' } },
    workspace: {
      getConfiguration: () => ({ get: (k) => config[k] }),
      onDidChangeConfiguration: (f) => { events.config.push(f); return { dispose() {} }; },
      onDidSaveTextDocument: (f) => { events.save.push(f); return { dispose() {} }; },
      findFiles: async () => [],
      getWorkspaceFolder: () => opts.folder,
      workspaceFolders: opts.folder ? [opts.folder] : undefined,
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: (f) => { events.editor.push(f); return { dispose() {} }; },
      createStatusBarItem: () => (log.statusItem = { show() { log.status = 'shown'; }, hide() { log.status = 'hidden'; } }),
      registerTreeDataProvider: (id, t) => { log.tree = t; return { dispose() {} }; },
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showErrorMessage: (m) => { log.errors.push(m); },
      showWarningMessage: async (m, o) => { log.warnings.push({ m, o }); return opts.warnAnswer; },
      showInformationMessage: (m) => { log.infos.push(m); },
      showQuickPick: async (items) => (opts.pick ? opts.pick(items) : items[0]),
      showInputBox: async (o) => (opts.input ? opts.input(o) : undefined),
      withProgress: async (o, f) => f(),
      showTextDocument: async (u) => { log.opened.push(u.fsPath); },
      createWebviewPanel: () => ({ webview: { html: '', asWebviewUri: (u) => u, cspSource: 'x' }, reveal() {}, onDidDispose() {} }),
    },
    commands: {
      registerCommand: (n, f) => { commands[n] = f; return { dispose() {} }; },
      executeCommand: async (...a) => {
        log.executed.push(a);
        if (a[0] === 'setContext') context[a[1]] = a[2];
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
    async listProblems() { return problems; }
    async fetchStatement() { return opts.statement || { data: Buffer.from('%PDF'), ext: '.pdf' }; }
    async fetchTestcases(id) { log.fetchedTests.push(id); return [{ input: '1\n', output: '1\n' }, { input: '2\n', output: '2\n' }]; }
    async submit(id, source) { log.submitted.push({ id, source }); return { id: '9' }; }
    async waitForGrade() { return { points: 100, max: 100, tests: [], done: true }; }
  }
  fake('lib/client.js', { GraderClient: FakeClient });
  fake('lib/statement.js', { statementHtml: () => '<html></html>' });

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
      getText() { return this.text; },
      edit(t) { this.text = t; this.dirty = true; },
      async save() { if (!this.dirty) return false; this.dirty = false; events.save.forEach((f) => f(doc)); return true; },
    };
    return doc;
  }
  function setEditor(doc) {
    vscode.window.activeTextEditor = doc ? { document: doc } : undefined;
    events.editor.forEach((f) => f(vscode.window.activeTextEditor));
  }
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const fireConfig = (key) => events.config.forEach((f) => f({ affectsConfiguration: (k) => k === key }));
  return { vscode, commands, context, log, config, secrets, makeDoc, setEditor, tick, fireConfig, storage };
}

module.exports = { loadExtension };
