'use strict';
// Reading test cases from the grader's test case page, which only shows the first part of each file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTestcasePage, GraderClient } = require('../lib/client');
const { comparedOutputs } = require('../lib/diff');
const { runTests, runSingle } = require('../lib/runner');
const { localResultsHtml } = require('../lib/resultsHtml');

// Same markup as the real page, with made-up data.
const file = (label, size, text) => `<div class='col-md-6'>
<div class='d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1'>
<h6 class='mb-0'>${label}</h6>
<div class='d-flex align-items-center gap-2'>
<span class='text-secondary small'>${size}</span>
</div>
</div>
<textarea class='form-control font-monospace small' readonly rows='20' spellcheck='false'>${text}</textarea>
</div>`;
const pane = (id, input, output) => `<div class='tab-pane' id='tc${id}' role='tabpanel'>
<div class='row g-3'>
${file('Input', ...input)}
${file('Expected output', ...output)}
</div>
</div>`;
const pageHtml = (...panes) => `<span class='badge'>
<span class='mi md-18'>content_cut</span>
Showing the first 2 KB of each file
</span>
<div class='tab-content'>${panes.join('\n')}</div>`;

const big = 'x'.repeat(2048);

test('reads each test from the page, decoding HTML entities', () => {
  const cases = parseTestcasePage(pageHtml(
    pane(1, ['3 Bytes', 'toy'], ['5 Bytes', 'toys\n']),
    pane(2, ['5 Bytes', 'a &lt; b'], ['4 Bytes', 'yes\n'])));
  assert.deepStrictEqual(cases.map((c) => [c.id, c.input, c.output, c.inputCut, c.outputCut]),
    [['1', 'toy', 'toys\n', false, false], ['2', 'a < b', 'yes\n', false, false]]);
});

test('drops a newline the page adds after <textarea>, but only when the size proves it is extra', () => {
  const [c] = parseTestcasePage(pageHtml(pane(1, ['1 Byte', '\n5'], ['2 Bytes', '\n\n'])));
  assert.strictEqual(c.input, '5');
  assert.strictEqual(c.output, '\n\n');
});

test('flags a file that is bigger than what the page shows', () => {
  const [c] = parseTestcasePage(pageHtml(pane(1, ['50 KB', big], ['3 Bytes', 'ok\n'])));
  assert.strictEqual(c.inputCut, true);
  assert.strictEqual(c.outputCut, false);
});

// Fake grader: the test page, plus download links that either work or bounce to a normal page.
function fakeGrader(html, downloads) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname);
    if (u.pathname.startsWith('/testcases/show_problem/')) return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/main/list') return new Response('<!DOCTYPE html><html>problem list</html>', { headers: { 'content-type': 'text/html' } });
    if (downloads) return new Response('full file\n', { headers: { 'content-type': 'text/plain' } });
    return new Response(null, { status: 302, headers: { location: '/main/list' } });
  };
  return { asked, restore: () => { globalThis.fetch = realFetch; } };
}

test('small tests come from the page without downloading anything', async () => {
  const g = fakeGrader(pageHtml(pane(7, ['3 Bytes', 'toy'], ['5 Bytes', 'toys\n'])), false);
  try {
    const cases = await new GraderClient('https://grader.test/').fetchTestcases(1);
    assert.deepStrictEqual(cases, [{ input: 'toy', output: 'toys\n' }]);
    assert.deepStrictEqual(g.asked, ['/testcases/show_problem/1']);
  } finally { g.restore(); }
});

test('a cut-off file is downloaded in full when the grader allows it', async () => {
  const g = fakeGrader(pageHtml(pane(7, ['50 KB', big], ['3 Bytes', 'ok\n'])), true);
  try {
    const [c] = await new GraderClient('https://grader.test/').fetchTestcases(1);
    assert.deepStrictEqual(c, { input: 'full file\n', output: 'ok\n' });
  } finally { g.restore(); }
});

test('when downloads are blocked, a web page is never saved as a test; the visible part is kept and flagged', async () => {
  const g = fakeGrader(pageHtml(pane(7, ['3 Bytes', 'abc'], ['50 KB', big])), false);
  try {
    const [c] = await new GraderClient('https://grader.test/').fetchTestcases(1);
    assert.strictEqual(c.input, 'abc');
    assert.strictEqual(c.output, big);
    assert.strictEqual(c.partialOutput, true);
    assert.ok(!/DOCTYPE/.test(c.input + c.output));
  } finally { g.restore(); }
});

test('a partly known expected output is checked on its complete lines only', () => {
  const tc = { output: 'a\nb\nc-cut-mid', partialOutput: true };
  assert.deepStrictEqual(comparedOutputs(tc, 'a\nb\nc-full\nd\n'), { expected: 'a\nb', actual: 'a\nb' });
  assert.deepStrictEqual(comparedOutputs({ output: 'x\n' }, 'y\n'), { expected: 'x\n', actual: 'y\n' });
});

test('runner skips a test whose input is only partly known and checks partial outputs by prefix', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-tc-'));
  const f = path.join(dir, 'sol.py');
  fs.writeFileSync(f, 'for i in range(int(input())): print(i)');
  const cfg = { pythonPath: 'python', cppCompiler: 'g++', cCompiler: 'gcc', timeoutMs: 10000 };
  try { await runSingle(f, '1\n', cfg); } catch { return t.skip('no python'); }
  const cases = [
    { input: '5\n', output: '0\n1\n2\n3', partialOutput: true },
    { input: '5\n', output: '0\n9\n2\n3', partialOutput: true },
    { input: '99999', partialInput: true, output: '' },
  ];
  const results = await runTests(f, cases, cfg);
  assert.deepStrictEqual(results.map((r) => r.verdict), ['PASS', 'FAIL', 'SKIP']);
  const html = localResultsHtml({ code: 'X' }, cases, results);
  assert.match(html, /1\/2 passed/);
  assert.match(html, /1 skipped/);
  assert.match(html, /only shows the start of this test's input/);
});

// ---- data files ("Data files read at run time")
const { parseDataFiles } = require('../lib/client');
const { mapDataPaths } = require('../lib/runner');
const dataSection = (...files) => `<div class='card shadow-sm mb-4' id='data-files'>
<div class='card-body'>
<h5 class='fw-bold mb-1'>Data files read at run time</h5>
<div class='row g-3'>${files.map(([name, size, text]) => file(name, size, text)).join('\n')}</div></div></div>`;

test('data files are read from their own section and not mistaken for a test', () => {
  const html = pageHtml(pane(1, ['19 Bytes', '/data/data.txt 2562'], ['14 Bytes', '50.0 90.0 70.0'])) +
    dataSection(['data.txt', '31 Bytes', '6230012121 90.0\n6230215221 50.0'], ['empty.txt', '0 Bytes', '']);
  assert.deepStrictEqual(parseTestcasePage(html).map((c) => c.input), ['/data/data.txt 2562']);
  assert.deepStrictEqual(parseDataFiles(html).map((f) => [f.name, f.text, f.cut]),
    [['data.txt', '6230012121 90.0\n6230215221 50.0', false], ['empty.txt', '', false]]);
  assert.deepStrictEqual(parseDataFiles(pageHtml(pane(1, ['1 Byte', 'x'], ['1 Byte', 'y']))), []);
});

test('/data/ paths in the input are pointed at the local copies', () => {
  const files = { 'data1.txt': '', 'data2.txt': '' };
  assert.strictEqual(mapDataPaths('/data/data1.txt /data/data2.txt', files), 'data/data1.txt data/data2.txt');
  assert.strictEqual(mapDataPaths('/data/other.txt', files), '/data/other.txt');
  assert.strictEqual(mapDataPaths('/data/x', undefined), '/data/x');
});

test('a program that opens /data/... from its input runs against the data files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-df-'));
  const f = path.join(dir, 'sol.py');
  fs.writeFileSync(f, 'a, b = input().split()\nprint(open(a).read().strip(), len(open(b).read()))');
  const cfg = { pythonPath: 'python', cppCompiler: 'g++', cCompiler: 'gcc', timeoutMs: 10000 };
  try { await runSingle(f, '1\n', cfg); } catch { return t.skip('no python'); }
  const files = { 'a.txt': 'hello', 'b.txt': '' };
  const cases = [{ input: '/data/a.txt /data/b.txt\n', output: 'hello 0\n', files }];
  assert.deepStrictEqual((await runTests(f, cases, cfg)).map((r) => r.verdict), ['PASS']);
  assert.strictEqual((await runSingle(f, '/data/a.txt /data/b.txt\n', cfg, files)).stdout.trim(), 'hello 0');
  assert.match(localResultsHtml({ code: 'X' }, cases, [{ verdict: 'PASS', ms: 1, stdout: '', stderr: '' }]), /Data files from the grader: a\.txt, b\.txt/);
});

test('fetchTestcases attaches the data files to every test', async () => {
  const html = pageHtml(pane(1, ['3 Bytes', 'abc'], ['1 Byte', 'x']), pane(2, ['3 Bytes', 'def'], ['1 Byte', 'y'])) +
    dataSection(['d.txt', '2 Bytes', 'hi']);
  const g = fakeGrader(html, false);
  try {
    const cases = await new GraderClient('https://grader.test/').fetchTestcases(1);
    assert.deepStrictEqual(cases.map((c) => c.files), [{ 'd.txt': 'hi' }, { 'd.txt': 'hi' }]);
  } finally { g.restore(); }
});
