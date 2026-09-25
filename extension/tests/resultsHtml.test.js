'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { localResultsHtml, singleResultHtml, submissionHtml, diffHtml } = require('../lib/resultsHtml');

test('user text is escaped in results', () => {
  const html = localResultsHtml({ code: 'P<1>' }, [{ input: '<script>alert(1)</script>', output: 'a&b' }],
    [{ verdict: 'FAIL', ms: 5, stdout: '<img src=x>', stderr: '<b>err</b>' }]);
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x>') && !html.includes('<b>err'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('P&lt;1&gt;'));
});

test('a spacing mistake shows the marked character and the spacing hint', () => {
  const html = diffHtml('Hello  Python.', 'Hello Python.');
  assert.ok(html.includes('First difference: line 1, column 7'));
  assert.ok(html.includes('<mark>'));
  assert.ok(html.includes('Only the spacing differs'));
  assert.ok(html.includes('Hello·<mark>·</mark>Python.')); // expected line: the extra space is the marked char
  assert.ok(html.includes('Hello·<mark>P</mark>ython.')); // your line: "P" sits where the second space should be
});

test('single run reports PASS when output matches, FAIL otherwise', () => {
  assert.ok(singleResultHtml('t', 'in', 'ok', { verdict: 'OK', ms: 1, stdout: 'ok\n', stderr: '' }).includes('v PASS'));
  assert.ok(singleResultHtml('t', 'in', 'ok', { verdict: 'OK', ms: 1, stdout: 'no', stderr: '' }).includes('v FAIL'));
  assert.ok(singleResultHtml('custom', 'in', undefined, { verdict: 'OK', ms: 1, stdout: 'x', stderr: '' }).includes('v OK'));
});

test('submission view handles grading, done and timed-out states', () => {
  const p = { code: '05_List_11' };
  assert.ok(submissionHtml(p, 5, { tests: [], status: 'queued', done: false }).includes('Grading'));
  const done = submissionHtml(p, 5, { tests: [{ n: 1, total: 1, label: 'Correct', letter: 'P' }], status: 'done', done: true, points: 100, max: 100, runtime: '0.01 s' });
  assert.ok(done.includes('100 / 100 points') && done.includes('tile ok'));
  assert.ok(submissionHtml(p, 5, { tests: [], status: 'x', done: false, timedOut: true }).includes('Still grading'));
});
