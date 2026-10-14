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

test('turning "Hide exam problems" off shows exams straight away', async () => {
  const problems = [
    { id: '1', code: '05_List_15', name: 'a', hasTestcases: true },
    { id: '2', code: 'Exam_01', name: 'Exam 1', hasTestcases: true },
  ];
  const h = loadExtension({ secrets: SIGNED_IN, problems });
  await settle(h);
  assert.deepStrictEqual(h.log.tree.getChildren().map((g) => g.label), ['05_List']);
  h.config.hideExams = false;
  h.fireConfig('nattee.hideExams');
  assert.deepStrictEqual(h.log.tree.getChildren().map((g) => g.label).sort(), ['05_List', 'Exam_01']);
});
