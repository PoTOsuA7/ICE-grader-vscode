'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseProblemList, parseSubmissionPage, parseSubmitForm, GraderClient } = require('../lib/client');

// Synthetic pages that follow the structure of the real grader's HTML.
const row = (id, code, status, score, sub) => `<tr>
<td class='text-end' data-order='1'><div>1</div></td>
<td><div class='d-flex align-items-center'><strong>
${code}_&ZeroWidthSpace;Name &amp; Co
</strong></div>
<div class='text-muted font-monospace'>
${code}
</div>
<a href="/problems/${id}/download/statement">Read</a> <a class="link-flex" href="/testcases/show_problem/${id}">Testcases</a>
</td>
<td data-order='${score}' style='width: 12em; vertical-align: middle'><div class='progress'></div></td>
<td>${sub ? `<a data-turbo="false" href="/submissions/${sub}">${sub}</a>` : '-'}</td>
<td>${status}</td>
</tr>`;

test('parseProblemList reads status, score, submission and cleans names', () => {
  const html = `<table><tbody><!-- x -->${row(10, '05_List_11', 'solved', '100.0', '555')}${row(11, '05_List_12', 'inprogress', '40.0', '556')}${row(12, '05_List_13', 'untried', '0', null)}</tbody></table>`;
  const list = parseProblemList(html);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((p) => p.status), ['solved', 'inprogress', 'untried']);
  assert.deepStrictEqual(list.map((p) => p.score), [100, 40, 0]);
  assert.strictEqual(list[0].lastSubmissionId, '555');
  assert.strictEqual(list[2].lastSubmissionId, null);
  assert.strictEqual(list[0].id, '10');
  assert.ok(list[0].name.includes('Name & Co') && !list[0].name.includes('&amp;'));
  assert.ok(list.every((p) => p.hasTestcases));
});

const field = (label, value) => `<div class='row mb-2'>\n<div class='col-4 text-end text-secondary'>\n${label}\n</div>\n<div class='col'>\n${value}\n</div>\n</div>`;
const tile = (n, total, label, letter) => `<span class="verdict-tile" title="Test ${n} of ${total}: ${label}">${letter}</span>`;

test('parseSubmissionPage reads points, status and per-test verdicts', () => {
  const html = field('Points', '60.0/100') + field('Result', tile(1, 2, 'Correct', 'P') + tile(2, 2, 'Wrong answer', '-')) +
    field('Runtime', "<span>0.014</span>\n<span class='x'>s</span>") + field('Grading Task Status', 'done');
  const g = parseSubmissionPage(html);
  assert.strictEqual(g.points, 60);
  assert.strictEqual(g.max, 100);
  assert.strictEqual(g.done, true);
  assert.strictEqual(g.runtime, '0.014 s');
  assert.deepStrictEqual(g.tests.map((t) => [t.n, t.label]), [[1, 'Correct'], [2, 'Wrong answer']]);
});

test('parseSubmissionPage reports a submission that is still grading', () => {
  const g = parseSubmissionPage(field('Grading Task Status', 'processing'));
  assert.strictEqual(g.done, false);
  assert.strictEqual(g.status, 'processing');
});

const formHtml = `<form action="/main/submit" method="post"><input type="hidden" name="authenticity_token" value="tok&#43;en" autocomplete="off" />
<input type="hidden" name="submission[problem_id]" id="submission_problem_id" value="892" autocomplete="off" />
<select id="language_id" name="language_id"><option value="6">Python</option><option value="2">C++</option></select></form>`;

test('parseSubmitForm reads token, problem and languages', () => {
  const f = parseSubmitForm(formHtml);
  assert.strictEqual(f.token, 'tok+en');
  assert.strictEqual(f.problemId, '892');
  assert.deepStrictEqual(f.languages, [{ id: '6', name: 'Python' }, { id: '2', name: 'C++' }]);
});

// ---- submit() against a fake server: checks exactly what would be sent, never touches the real grader ----
function fakeServer() {
  const posted = [];
  const respond = (body, init, url) => {
    const r = new Response(body, init);
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'POST') {
      posted.push(Object.fromEntries(opts.body.entries()));
      return respond('', { status: 302, headers: { location: '/submissions/777' } }, url);
    }
    if (u.pathname === '/submissions/777') return respond('graded', { status: 200 }, url);
    if (u.pathname.startsWith('/submissions/direct_edit_problem/')) return respond(formHtml, { status: 200 }, url);
    return respond('nope', { status: 404 }, url);
  };
  return posted;
}

test('submit sends the form the grader expects', async () => {
  const realFetch = globalThis.fetch;
  try {
    const posted = fakeServer();
    const c = new GraderClient('https://grader.test/');
    const r = await c.submit('892', 'print(1)\n', '.py');
    assert.strictEqual(r.id, '777');
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], {
      authenticity_token: 'tok+en', editor_text: 'print(1)\n', 'submission[problem_id]': '892', language_id: '6', commit: 'Submit',
    });
  } finally { globalThis.fetch = realFetch; }
});

test('submit refuses a language the problem does not offer, without posting', async () => {
  const realFetch = globalThis.fetch;
  try {
    const posted = fakeServer();
    const c = new GraderClient('https://grader.test/');
    await assert.rejects(() => c.submit('892', 'x', '.rs'), /doesn't accept \.rs/);
    assert.strictEqual(posted.length, 0);
  } finally { globalThis.fetch = realFetch; }
});
