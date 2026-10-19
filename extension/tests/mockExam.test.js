'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickProblems, clock, stamp, summarize } = require('../lib/mockExam');
const { mockReportHtml } = require('../lib/resultsHtml');
const { chapterOf } = require('../lib/layout');
const groupOf = (p) => chapterOf(p.code);

const P = (id, code, status = 'untried', hasTestcases = true) => ({ id, code, name: code, status, hasTestcases });
const problems = [
  P('1', '2025s1_Exam2_A1-1_Student', 'solved'),
  P('2', '2025s1_Exam2_A2-1_Student'),
  P('3', '2025s1_Exam2_B1-1_Student', 'inprogress'),
  P('4', 'Exam1-2024_Q1A_student', 'untried', false), // no tests: can't be marked
  P('5', '05_List_15'),
];

test('a mock takes problems with tests from the chosen groups, unsolved ones first', () => {
  for (let seed = 0; seed < 20; seed++) {
    const random = () => ((seed * 7919 + 13) % 97) / 97;
    const two = pickProblems(problems, ['Exam2'], 2, groupOf, random);
    assert.deepStrictEqual(two.map((p) => p.id).sort(), ['2', '3'], 'the solved one only when needed');
    const all = pickProblems(problems, ['Exam1', 'Exam2'], 9, groupOf, random);
    assert.deepStrictEqual(all.map((p) => p.id).sort(), ['1', '2', '3']);
    assert.strictEqual(all[2].id, '1', 'solved last');
  }
  assert.deepStrictEqual(pickProblems(problems, ['05_List'], 3, groupOf).map((p) => p.id), ['5']);
});

test('the clock counts down in minutes and seconds, with hours when needed', () => {
  assert.strictEqual(clock(90 * 60000), '1:30:00');
  assert.strictEqual(clock(5 * 60000 + 1), '5:01');
  assert.strictEqual(clock(59000), '0:59');
  assert.strictEqual(clock(-5000), '0:00');
  assert.strictEqual(stamp(new Date(2026, 9, 17, 9, 5)), '2026-10-17_0905');
});

test('each problem counts the same; skipped tests count neither way; not attempted scores 0', () => {
  const r = (...v) => v.map((verdict) => ({ verdict }));
  const s = summarize([
    { code: 'A', results: r('PASS', 'PASS', 'SKIP') },        // 2/2
    { code: 'B', results: r('PASS', 'FAIL', 'TLE', 'FAIL') }, // 1/4
    { code: 'C', note: 'Not attempted' },                     // 0
  ]);
  assert.deepStrictEqual(s.per.map((x) => [x.passed, x.ran]), [[2, 2], [1, 4], [0, 0]]);
  assert.strictEqual(s.percent, Math.round((100 * (1 + 0.25 + 0)) / 3));
});

test('the report shows the score, each problem, past mocks, and that it is unofficial', () => {
  const cases = [{ input: '1\n', output: '1\n' }];
  const summary = summarize([
    { code: 'A<b>', cases, results: [{ verdict: 'PASS', ms: 3, stdout: '1\n', stderr: '' }] },
    { code: 'B', note: 'Compilation failed: x.c:1: error' },
  ]);
  const html = mockReportHtml(summary, { minutesUsed: 42, minutes: 90, history: [{ date: Date.UTC(2026, 9, 16), percent: 25 }, { date: Date.UTC(2026, 9, 17), percent: 50 }] });
  assert.match(html, /Mock exam: <b>50%<\/b>/);
  assert.match(html, /42 of 90 minutes used/);
  assert.match(html, /A&lt;b&gt;/);
  assert.doesNotMatch(html, /A<b>/);
  assert.match(html, /Compilation failed/);
  assert.match(html, /25% → .*50%/);
  assert.match(html, /Unofficial/);
});
