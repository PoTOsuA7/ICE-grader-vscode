'use strict';
// extension.js itself, with VS Code faked (see vscode-harness.js). Nothing here talks to the grader or Gemini.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadExtension } = require('./vscode-harness');
const pkg = require('../package.json');

const SIGNED_IN = { 'nattee.uid': 'u', 'nattee.password': 'pw' };
const FILE = path.join('C:', 'ws', '05_List_15.py');
const settle = (h) => h.tick(120);

test('activates and registers exactly the commands package.json declares', () => {
  const h = loadExtension();
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(Object.keys(h.commands).sort(), declared);
  for (const entries of Object.values(pkg.contributes.menus)) {
    for (const m of entries) assert.ok(declared.includes(m.command), `menu uses unknown command ${m.command}`);
  }
});

test('every inline / title-bar menu button has an icon', () => {
  const icons = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.icon]));
  for (const entries of Object.values(pkg.contributes.menus)) {
    for (const m of entries) {
      if (m.group === 'inline' || m.group === 'navigation') assert.ok(icons[m.command], `${m.command} has no icon`);
    }
  }
});

test('the grader address cannot be changed from a workspace', () => {
  assert.strictEqual(pkg.contributes.configuration.properties['nattee.rootUrl'].scope, 'application');
});

test('a saved password is never sent to a different grader address, or over http', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, config: { rootUrl: 'https://evil.example/' } });
  await settle(h);
  assert.deepStrictEqual(h.log.logins, [], 'no sign-in at start-up for another host');
  h.config.rootUrl = 'http://2190101.nattee.net/';
  h.fireConfig('nattee.rootUrl');
  await settle(h);
  assert.deepStrictEqual(h.log.logins, [], 'no sign-in over http');
  h.config.rootUrl = 'https://2190101.nattee.net/';
  h.fireConfig('nattee.rootUrl');
  await settle(h);
  assert.deepStrictEqual(h.log.logins.map((l) => l.root), ['https://2190101.nattee.net/'], 'the grader the password was saved for still works');
});

test('signing in remembers the grader address; signing out forgets it', async () => {
  const answers = ['u', 'pw'];
  const h = loadExtension({ input: () => answers.shift() });
  await h.commands['nattee.login']();
  assert.strictEqual(h.secrets.get('nattee.origin'), 'https://2190101.nattee.net');
  await h.commands['nattee.logout']();
  assert.strictEqual(h.secrets.has('nattee.origin'), false);
});

test('the Run/Submit buttons appear after signing in and go away after signing out', async () => {
  const answers = ['u', 'pw'];
  const h = loadExtension({ input: () => answers.shift() });
  h.setEditor(h.makeDoc(FILE));
  assert.strictEqual(h.context['nattee.activeFileLinked'], false);
  await h.commands['nattee.login']();
  assert.strictEqual(h.context['nattee.activeFileLinked'], true);
  assert.strictEqual(h.log.status, 'shown');
  await h.commands['nattee.logout']();
  assert.strictEqual(h.context['nattee.activeFileLinked'], false);
  assert.strictEqual(h.log.status, 'hidden');
});

test('submit always asks first, sends nothing when not confirmed, and never runs on save', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, warnAnswer: undefined });
  await settle(h);
  const doc = h.makeDoc(FILE, 'print(2)');
  h.setEditor(doc);
  await h.commands['nattee.submit']();
  assert.strictEqual(h.log.warnings.length, 1);
  assert.strictEqual(h.log.warnings[0].o.modal, true);
  assert.deepStrictEqual(h.log.submitted, []);
  doc.edit('print(3)');
  await doc.save();
  await settle(h);
  assert.deepStrictEqual(h.log.submitted, []);
});

test('the code recorded for a run is the code that was run, and a save during a run gets its own run', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, runMs: 150 });
  await settle(h);
  const doc = h.makeDoc(FILE, 'v0');
  h.setEditor(doc);
  doc.edit('v1');
  await doc.save(); // starts an automatic run of v1
  await h.tick(40);
  doc.edit('v2');
  await doc.save(); // saved while v1 is running
  await h.tick(60);
  // Submit's note while the v2 rerun is still going: v2 has not been tested yet.
  await h.commands['nattee.submit']();
  assert.match(h.log.warnings[0].o.detail, /have not been run on this version/);
  await h.tick(400);
  assert.strictEqual(h.log.runs.filter((r) => !r.single).length, 2, 'v1 run + one queued run for v2');
  await h.commands['nattee.submit']();
  assert.match(h.log.warnings[1].o.detail, /Local tests: 2\/2 passed/);
});

test('a manual run or single test on an unsaved file runs once, not twice', async () => {
  const h = loadExtension({ secrets: SIGNED_IN });
  await settle(h);
  const doc = h.makeDoc(FILE);
  h.setEditor(doc);
  doc.edit('print(5)');
  await h.commands['nattee.runTests']();
  await settle(h);
  assert.strictEqual(h.log.runs.length, 1);
  doc.edit('print(6)');
  await h.commands['nattee.runOneTest']();
  await settle(h);
  assert.deepStrictEqual(h.log.runs.map((r) => !!r.single), [false, true]);
});

test('relinking a file drops the old problem\'s results', async () => {
  const problems = [
    { id: '1', code: '05_List_15', name: 'a', hasTestcases: true },
    { id: '2', code: '05_List_16', name: 'b', hasTestcases: true },
  ];
  let pickCode = '05_List_15';
  const h = loadExtension({ secrets: SIGNED_IN, problems, pick: (items) => items.find((i) => i.label === pickCode) });
  await settle(h);
  const doc = h.makeDoc(path.join('C:', 'ws', 'x.py'));
  h.setEditor(doc);
  await h.commands['nattee.linkFile']();
  await h.commands['nattee.runTests']();
  pickCode = '05_List_16';
  await h.commands['nattee.linkFile']();
  await h.commands['nattee.submit']();
  assert.match(h.log.warnings[0].m, /05_List_16/);
  assert.match(h.log.warnings[0].o.detail, /have not been run on this version/);
});

test('notes and input files named after a problem are not treated as solutions', async () => {
  const h = loadExtension({ secrets: SIGNED_IN });
  await settle(h);
  const doc = h.makeDoc(path.join('C:', 'ws', '05_List_15_input.txt'));
  h.setEditor(doc);
  assert.strictEqual(h.context['nattee.activeFileLinked'], false);
  doc.edit('1 2 3');
  await doc.save();
  await settle(h);
  assert.deepStrictEqual(h.log.runs, []);
  assert.deepStrictEqual(h.log.errors, []);
});

test('a non-PDF statement opens beside the code once, without taking focus each time', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, statement: { data: Buffer.from('<h1>x</h1>'), ext: '.html' } });
  await settle(h);
  const doc = h.makeDoc(FILE);
  h.setEditor(doc);
  await settle(h);
  h.setEditor(undefined);
  h.setEditor(doc);
  await settle(h);
  const opens = h.log.executed.filter((a) => a[0] === 'vscode.open');
  assert.strictEqual(opens.length, 1);
  assert.deepStrictEqual(opens[0][2], { viewColumn: h.vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
});

test('exam problems are always listed, even with the old "hideExams" setting still in settings.json', async () => {
  const problems = [
    { id: '1', code: '05_List_15', name: 'a', hasTestcases: true },
    { id: '2', code: 'Exam_01', name: 'Exam 1', hasTestcases: true },
  ];
  const h = loadExtension({ secrets: SIGNED_IN, problems, config: { hideExams: true } });
  await settle(h);
  assert.deepStrictEqual(h.log.tree.getChildren().map((g) => g.label), ['05_List', 'Exam1']);
  assert.ok(!('nattee.hideExams' in pkg.contributes.configuration.properties));
});

// As listed on the grader: exam practice with tests, and older exam practice with only a statement.
const EXAM_PROBLEMS = [
  { id: '1', code: '05_List_15', name: '05_List_15_Foo', hasTestcases: true, status: 'solved', score: 100 },
  { id: '1498', code: '2025s1_Exam2_A1-1_Student', name: '2025s1_Exam2_A1-1_Student', hasTestcases: true, status: 'untried', score: 0 },
  { id: '1500', code: '2025s1_Exam2_A2-1_Student', name: '2025s1_Exam2_A2-1_Student', hasTestcases: true, status: 'inprogress', score: 40 },
  { id: '1369', code: 'Exam1-2024_Q1A_student', name: 'Exam1-2024_Q1A_student', hasTestcases: false, status: 'untried', score: 0 },
  { id: '1370', code: 'Exam1-2024_Q2A_student', name: 'Exam1-2024_Q2A_student', hasTestcases: false, status: 'untried', score: 0 },
];

test('exam practice problems are listed by default, grouped by exam, including those without test cases', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS });
  await settle(h);
  const groups = h.log.tree.getChildren();
  assert.deepStrictEqual(groups.map((g) => [g.label, g.description]),
    [['05_List', '1/1 solved'], ['Exam1', '0/2 solved'], ['Exam2', '0/2 solved']]);
  const exam1 = h.log.tree.getChildren(groups[1]);
  assert.deepStrictEqual(exam1.map((i) => [i.label, i.description]),
    [['Exam1-2024_Q1A_student', 'no tests'], ['Exam1-2024_Q2A_student', 'no tests']]);
  const exam2 = h.log.tree.getChildren(groups[2]);
  assert.deepStrictEqual(exam2.map((i) => i.description), ['', '40'], 'the name repeats the code, so it is not shown twice');
});

test('a problem without test cases: no test download, no automatic runs, a clear message, own input still works', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, warnAnswer: undefined });
  await settle(h);
  const doc = h.makeDoc(path.join('C:', 'ws', 'Exam1', 'Exam1-2024_Q1A_student.py'), 'print(1)');
  h.setEditor(doc);
  await settle(h);
  assert.strictEqual(h.context['nattee.activeFileLinked'], true, 'linked by its name, so Submit is there');
  assert.strictEqual(h.log.statusItem.command, 'nattee.runOneTest');
  doc.edit('print(2)');
  await doc.save();
  await settle(h);
  assert.deepStrictEqual(h.log.runs, [], 'nothing to run on save');
  await h.commands['nattee.runTests']();
  assert.match(h.log.infos.at(-1), /no test cases on the grader/);
  await h.commands['nattee.submit']();
  assert.match(h.log.warnings[0].o.detail, /no test cases to run locally/);
  assert.deepStrictEqual(h.log.submitted, [], 'not confirmed, so nothing sent');
  assert.deepStrictEqual(h.log.fetchedTests, []);
  assert.deepStrictEqual(h.log.errors, []);
});

// ------------------------------------------------------------ v0.4 features
const fs = require('fs');
const os = require('os');
const tempFolder = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-ws-'));
  return { uri: { scheme: 'file', fsPath: dir, path: dir }, dir };
};

test('every problem row has a visible Start (create solution) button', () => {
  const inline = pkg.contributes.menus['view/item/context'].filter((m) => m.group === 'inline').map((m) => m.command);
  assert.ok(inline.includes('nattee.createSolution'));
});

test('a problem list that fails to load at start-up is reported, not hidden', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, listError: 'fetch failed' });
  await settle(h);
  assert.match(h.log.warnings.map((w) => w.m).join('\n'), /couldn't load the problem list \(fetch failed\)/);
});

// Opens a Run in Terminal terminal and waits for its program to end; -> what it showed, colours removed.
async function openAndWait(h, t) {
  let shown = '';
  t.pty.onDidWrite((s) => { shown += s; });
  t.pty.open();
  for (let i = 0; i < 100 && !/--- program/.test(shown); i++) await h.tick(50);
  return shown.replace(/\x1b\[[0-9;]*m/g, '');
}

test('Run in Terminal runs the file in its own terminal; running it again replaces the last run', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, pick: (items) => items.find((i) => i.kind === 'terminal') });
  await settle(h);
  h.setEditor(h.makeDoc(FILE));
  // from Run One Test's list too: "type the input yourself in the terminal"
  await h.commands['nattee.runOneTest']();
  assert.ok(h.log.pickItems[0].some((i) => i.kind === 'terminal'));
  const [t] = h.log.terminals;
  assert.deepStrictEqual([t.name, typeof t.pty.handleInput, t.shown], ['Run 05_List_15.py', 'function', true]);
  await h.commands['nattee.runInTerminal']();
  assert.strictEqual(h.log.terminals.length, 2);
  assert.ok(t.disposed, 'the last run is closed');
  assert.strictEqual(h.log.cleanups, 1, 'and cleaned up');
  h.log.terminals[1].dispose();
  assert.strictEqual(h.log.cleanups, 2);
});

test('Run in Terminal keeps the output on screen, and gives the program the problem\'s data files', async () => {
  const cases = [{ input: '/data/d.txt\n', output: 'x\n', files: { 'd.txt': 'hello\n' } }];
  const program = "console.log(process.cwd()); process.stdout.write(require('fs').readFileSync('data/d.txt', 'utf8'))";
  const h = loadExtension({ secrets: SIGNED_IN, cases, terminalCommand: () => ({ cmd: process.execPath, args: ['-e', program] }) });
  await settle(h);
  h.setEditor(h.makeDoc(FILE));
  await h.commands['nattee.runInTerminal']();
  const [t] = h.log.terminals;
  const shown = await openAndWait(h, t);
  assert.match(shown, /where it says \/data\/d\.txt, type data\/d\.txt/);
  assert.match(shown, /hello\r\n\r\n--- program finished\./);
  assert.ok(!t.disposed, 'the terminal stays open after the program ends');
  const dir = shown.split('\r\n').find((l) => l.includes('nattee'));
  assert.ok(dir && !fs.existsSync(dir), `the data folder (${dir}) is removed once the program has ended`);
  assert.strictEqual(h.log.cleanups, 1);
});

test('Create Solution never reuses a mock exam answer as the solution', async () => {
  const ws = tempFolder();
  const h = loadExtension({ secrets: SIGNED_IN, folder: ws });
  await settle(h);
  await h.commands['nattee.createSolution']({ problem: { id: '1', code: '05_List_15', name: 'x' } });
  assert.match(h.log.findFiles[0].exclude, /mock-exams/);
  assert.match(h.log.findFiles[0].exclude, /nattee-export-\*/, 'nor a downloaded copy of a submission');
});

// Picks Exam2, 2 problems, 90 minutes; anything else (Run One Test's list) the first item.
const mockPick = (items, o) => (o.canPickMany ? items.filter((i) => i.label === 'Exam2')
  : /How many/.test(o.placeHolder) ? items.find((i) => i.n === 2)
    : /How long/.test(o.placeHolder) ? items.find((i) => i.m === 90) : items[0]);

test('a mock exam: fresh files, no tests/AI/submit until hand-in, then everything is marked', async () => {
  const ws = tempFolder();
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, folder: ws, pick: mockPick, warnAnswer: 'Hand In' });
  await settle(h);
  await h.commands['nattee.startMockExam']();
  const m = h.gstate.get('nattee.mock');
  assert.deepStrictEqual(m.items.map((it) => it.code).sort(), ['2025s1_Exam2_A1-1_Student', '2025s1_Exam2_A2-1_Student']);
  assert.strictEqual(m.deadline - m.started, 90 * 60000);
  for (const it of m.items) {
    assert.ok(it.file.startsWith(path.join(ws.dir, 'mock-exams') + path.sep), it.file);
    assert.strictEqual(fs.readFileSync(it.file, 'utf8'), '', 'a fresh, empty file');
  }
  assert.deepStrictEqual(h.log.fetchedTests.sort(), ['1498', '1500'], 'downloaded before the clock starts');
  assert.strictEqual(h.context['nattee.mockExam'], true);
  assert.match(h.log.statusItems[1].text, /1:30:00 left · Hand in|1:29:5\d left · Hand in/);

  // During the mock: saving runs nothing; tests, submit and AI refuse; only your own input runs.
  const [a, b] = m.items;
  const doc = h.makeDoc(a.file, '');
  h.setEditor(doc);
  assert.strictEqual(h.log.statusItem.command, 'nattee.runInTerminal');
  doc.edit('print(1)');
  await doc.save();
  await settle(h);
  assert.deepStrictEqual(h.log.runs, []);
  for (const c of ['nattee.runTests', 'nattee.submit', 'nattee.explainFailure']) await h.commands[c]();
  assert.strictEqual(h.log.errors.filter((e) => /Mock exam in progress/.test(e)).length, 3);
  assert.deepStrictEqual(h.log.submitted, []);
  await h.commands['nattee.runOneTest']();
  assert.ok(!h.log.pickItems.at(-1).some((i) => i.kind === 'test'), 'no grader tests offered');

  // Hand in: the answered problem is marked, the empty one scores 0.
  await h.commands['nattee.handInMockExam']();
  assert.deepStrictEqual(h.log.runs.map((r) => r.file), [a.file]);
  assert.match(h.log.view.webview.html, /Mock exam: <b>50%<\/b>/);
  const report = h.log.view.webview.html;
  assert.ok(report.indexOf('Not attempted') > report.indexOf(b.code), 'the empty answer is "Not attempted"');
  assert.strictEqual(h.gstate.get('nattee.mock'), undefined);
  assert.strictEqual(h.context['nattee.mockExam'], false);
  assert.strictEqual(h.gstate.get('nattee.mockHistory')[0].percent, 50);
  assert.match(h.log.infos.at(-1), /Mock exam marked: 50%/);
  // and the help is back
  const before = h.log.runs.length;
  await h.commands['nattee.runTests']();
  assert.strictEqual(h.log.runs.length, before + 1);
});

test('a mock exam carries on after VS Code restarts, and is marked if its time ran out meanwhile', async () => {
  const ws = tempFolder();
  const file = path.join(ws.dir, 'mock-exams', 'x', '2025s1_Exam2_A1-1_Student.py');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'print(1)');
  const now = Date.now();
  const item = { id: '1498', code: '2025s1_Exam2_A1-1_Student', file };
  const running = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, folder: ws,
    globalState: { 'nattee.mock': { started: now, deadline: now + 3600000, minutes: 60, items: [item] } } });
  await settle(running);
  assert.strictEqual(running.context['nattee.mockExam'], true);
  assert.strictEqual(running.log.statusItems[1].visible, true);
  assert.deepStrictEqual(running.log.runs, []);

  const over = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, folder: ws,
    globalState: { 'nattee.mock': { started: now - 7200000, deadline: now - 60000, minutes: 60, items: [item] } } });
  await settle(over);
  assert.deepStrictEqual(over.log.runs.map((r) => r.file), [file]);
  assert.match(over.log.infos.at(-1), /time is up\. Mock exam marked: 100%/);
  assert.strictEqual(over.gstate.get('nattee.mock'), undefined);
});

test('Download All saves every statement and test once; then a mock exam starts with the grader site down', async () => {
  const opts = { secrets: SIGNED_IN, problems: EXAM_PROBLEMS, folder: tempFolder(), pick: mockPick };
  const h = loadExtension(opts);
  await settle(h);
  await h.commands['nattee.downloadAll']();
  assert.deepStrictEqual([...h.log.fetchedStatements].sort(), EXAM_PROBLEMS.map((p) => p.id).sort());
  assert.deepStrictEqual([...h.log.fetchedTests].sort(), ['1', '1498', '1500'], 'only problems that have tests');
  assert.strictEqual(h.log.progress.length, EXAM_PROBLEMS.length);
  assert.match(h.log.infos.at(-1), /all 5 problems saved/);
  await h.commands['nattee.downloadAll']();
  assert.strictEqual(h.log.fetchedStatements.length, 5, 'nothing is downloaded twice');
  assert.strictEqual(h.log.fetchedTests.length, 3);

  // The site goes down: the mock exam still starts, from what was saved.
  opts.listError = 'fetch failed';
  opts.failIds = EXAM_PROBLEMS.map((p) => p.id);
  await h.commands['nattee.startMockExam']();
  assert.ok(h.gstate.get('nattee.mock'), 'the mock started');
  assert.strictEqual(h.log.fetchedTests.length, 3);
  assert.deepStrictEqual(h.log.errors, []);
});

test('Download All says which problems failed, and can be stopped', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, failIds: ['1498'] });
  await settle(h);
  await h.commands['nattee.downloadAll']();
  assert.match(h.log.warnings.at(-1).m, /saved 4 of 5 problems for offline use\. Couldn't download 2025s1_Exam2_A1-1_Student /);

  const stop = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, cancelAfter: 2 });
  await settle(stop);
  await stop.commands['nattee.downloadAll']();
  assert.match(stop.log.infos.at(-1), /stopped\. [34] of 5 problems saved - press Download All again for the rest/);
  assert.ok(stop.log.fetchedStatements.length < 5, 'the ones already started finish, no new ones');
});

test('a mock exam that can\'t get its problems starts no clock and says how to practise offline', async () => {
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXAM_PROBLEMS, folder: tempFolder(), pick: mockPick, failIds: ['1498', '1500'] });
  await settle(h);
  await h.commands['nattee.startMockExam']();
  assert.match(h.log.errors.at(-1), /couldn't get the mock exam's problems \(HTTP 500\).*Download All for Offline/);
  assert.strictEqual(h.gstate.get('nattee.mock'), undefined);
});

const EXPORT_PROBLEMS = [
  { id: '1', code: '05_List_15', name: '05_List_15_Foo', hasTestcases: true, status: 'solved', score: 100, lastSubmissionId: '501' },
  { id: '2', code: '05_List_16', name: '05_List_16_Bar', hasTestcases: true, status: 'untried', score: 0, lastSubmissionId: null },
  { id: '1498', code: '2025s1_Exam2_A1-1_Student', name: '2025s1_Exam2_A1-1_Student', hasTestcases: true, status: 'inprogress', score: 40, lastSubmissionId: '502' },
];
const LIST_15 = { problem: { id: '1', code: '05_List_15', name: '05_List_15_Foo' } };

test('the statement tab has Copy and Save buttons; Copy puts the statement text on the clipboard', async () => {
  const buttons = pkg.contributes.menus['editor/title'].filter((m) => m.when.includes("activeWebviewPanelId == 'natteeStatement'"));
  assert.deepStrictEqual(buttons.map((m) => m.command).sort(), ['nattee.copyStatement', 'nattee.saveStatement']);
  const h = loadExtension({ secrets: SIGNED_IN, statementPages: ['Find the sum.   \n\n\n\nInput: two numbers'] });
  await settle(h);
  await h.commands['nattee.copyStatement']();
  assert.match(h.log.errors.at(-1), /Open a problem's statement first/);
  await h.commands['nattee.openProblem'](LIST_15);
  await h.commands['nattee.copyStatement']();
  assert.deepStrictEqual(h.log.clipboard, ['05_List_15\n\nFind the sum.\n\nInput: two numbers\n']);
  assert.match(h.log.infos.at(-1), /05_List_15's statement copied/);
});

test('a statement with a page whose words are drawn, not written, is copied as a picture', async () => {
  const pages = ['  \n ', 'Example\nInput Output\nAAAAA 5 0011 ABBBB'];
  const h = loadExtension({ secrets: SIGNED_IN, statementPages: pages });
  await settle(h);
  await h.commands['nattee.openProblem'](LIST_15);
  await h.commands['nattee.copyStatement']();
  assert.deepStrictEqual(h.log.clipboardPictures.map((png) => png.subarray(0, 4).toString('latin1')), ['\x89PNG']);
  assert.deepStrictEqual(h.log.clipboard, [], 'not the text, which would miss the drawn page');
  assert.match(h.log.infos.at(-1), /copied as a picture \(part of it isn't text\) - paste it into a chat or an AI\.$/);

  // a long one: the pages are small in one picture, so it says the PDF is the better way
  const long = loadExtension({ secrets: SIGNED_IN, statementPages: [...pages, ...pages, ...pages, ...pages] });
  await settle(long);
  await long.commands['nattee.openProblem'](LIST_15);
  await long.commands['nattee.copyStatement']();
  assert.strictEqual(long.log.clipboardPictures.length, 1);
  assert.match(long.log.infos.at(-1), /It's 8 pages, so they're small in it: if they can't be read, use Save Statement As\.\.\. and attach the PDF\./);

  // if the picture can't go on the clipboard: the text there is, and what to do instead
  const noPic = loadExtension({ secrets: SIGNED_IN, statementPages: pages, pictureError: 'xclip is not installed' });
  await settle(noPic);
  await noPic.commands['nattee.openProblem'](LIST_15);
  await noPic.commands['nattee.copyStatement']();
  assert.deepStrictEqual(noPic.log.clipboard, ['05_List_15\n\nExample\nInput Output\nAAAAA 5 0011 ABBBB\n']);
  assert.match(noPic.log.warnings.at(-1).m, /couldn't be copied as a picture \(xclip is not installed\)\. The rest was copied\. Use Save Statement As/);
});

test('Copy is off during a mock exam', async () => {
  const now = Date.now();
  const mocking = loadExtension({ secrets: SIGNED_IN, globalState: { 'nattee.mock': { started: now, deadline: now + 3600000, minutes: 60, items: [] } } });
  await settle(mocking);
  await mocking.commands['nattee.openProblem'](LIST_15);
  await mocking.commands['nattee.copyStatement']();
  assert.match(mocking.log.errors.at(-1), /Mock exam in progress: copying the statement is off/);
  assert.deepStrictEqual(mocking.log.clipboard, []);
});

test('Save Statement As copies the PDF where you choose (Downloads suggested)', async () => {
  const target = path.join(tempFolder().dir, 'mine.pdf');
  const h = loadExtension({ secrets: SIGNED_IN, saveTo: target });
  await settle(h);
  await h.commands['nattee.openProblem'](LIST_15);
  await h.commands['nattee.saveStatement']();
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '%PDF');
  assert.strictEqual(path.basename(h.log.saveDialogs[0].defaultUri.fsPath), '05_List_15.pdf');
  assert.match(h.log.infos.at(-1), /saved mine\.pdf/);
});

test('Download All Statements and My Solutions: every statement and your latest code, in a new folder each time', async () => {
  const out = tempFolder().dir;
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXPORT_PROBLEMS, openFolder: out,
    sources: { 502: { source: 'int main() {}\n', language: 'C++' } } });
  await settle(h);
  await h.commands['nattee.exportAll']();
  const [dir] = fs.readdirSync(out);
  assert.match(dir, /^nattee-export-\d{4}-\d{2}-\d{2}$/);
  const files = (sub) => fs.readdirSync(path.join(out, dir, sub)).sort();
  assert.deepStrictEqual(files('05_List'), ['05_List_15.pdf', '05_List_15.py', '05_List_16.pdf'], 'no code for a problem never submitted');
  assert.deepStrictEqual(files('Exam2'), ['2025s1_Exam2_A1-1_Student.cpp', '2025s1_Exam2_A1-1_Student.pdf']);
  assert.strictEqual(fs.readFileSync(path.join(out, dir, '05_List', '05_List_15.py'), 'utf8'), 'print(501)\n');
  assert.strictEqual(fs.readFileSync(path.join(out, dir, 'Exam2', '2025s1_Exam2_A1-1_Student.cpp'), 'utf8'), 'int main() {}\n');
  assert.match(h.log.infos.at(-1), /saved all 3 statements and 2 solutions/);
  assert.deepStrictEqual(h.log.submitted, []);
  await h.commands['nattee.exportAll']();
  assert.deepStrictEqual(fs.readdirSync(out).sort(), [dir, `${dir}-2`], 'nothing overwritten');
});

test('Download All Statements and My Solutions says what failed; no folder chosen, nothing done', async () => {
  const none = loadExtension({ secrets: SIGNED_IN, problems: EXPORT_PROBLEMS });
  await settle(none);
  await none.commands['nattee.exportAll']();
  assert.deepStrictEqual([none.log.fetchedStatements, none.log.fetchedSources], [[], []]);
  const h = loadExtension({ secrets: SIGNED_IN, problems: EXPORT_PROBLEMS, openFolder: tempFolder().dir, failStatements: ['2'] });
  await settle(h);
  await h.commands['nattee.exportAll']();
  assert.match(h.log.warnings.at(-1).m, /saved 2 of 3 problems \(2 with your latest submitted code\)\. Couldn't download 05_List_16\./);
});
