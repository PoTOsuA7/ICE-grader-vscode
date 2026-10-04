'use strict';
// HTML for the "Test Results" sidebar view. Pure functions (no VS Code API) so they can be unit-tested.
const { firstDifference, visible, comparedOutputs } = require('./diff');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s) => (s.length > 3000 ? s.slice(0, 3000) + ' ... (truncated)' : s);

const STYLE = `
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px}
  .sum{font-size:1.15em;margin-bottom:10px} .ms{opacity:.6;margin-left:8px}
  summary{cursor:pointer;padding:4px 0}
  .v{display:inline-block;min-width:44px;text-align:center;border-radius:3px;padding:0 6px;color:#fff;font-weight:600}
  .PASS,.OK{background:#2e7d32}.FAIL{background:#c62828}.TLE{background:#ef6c00}.RE{background:#6a1b9a}.SKIP{background:#616161}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
  pre{background:var(--vscode-textCodeBlock-background);padding:6px;overflow:auto;max-height:240px;margin:0;white-space:pre-wrap;word-break:break-all}
  .err{color:var(--vscode-errorForeground)} h4{margin:6px 0 2px}
  .diff{border-left:3px solid #c62828;padding:4px 8px;margin:6px 0;background:var(--vscode-textCodeBlock-background)}
  .diff code{display:block;white-space:pre-wrap;word-break:break-all}
  mark{background:#c62828;color:#fff;border-radius:2px}
  .hint{margin:4px 0;color:var(--vscode-editorWarning-foreground)}
  .tiles{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0}
  .tile{width:22px;text-align:center;border-radius:3px;color:#fff;font-weight:600;font-size:.85em}
  .tile.ok{background:#2e7d32}.tile.bad{background:#c62828}
  .ai p{margin:6px 0} .ai code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}
  .ai pre{background:var(--vscode-textCodeBlock-background);padding:8px;overflow:auto;border-radius:4px}
`;

const page = (body) => `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>${STYLE}</style></head><body>${body}</body></html>`;

// Explains where two outputs first differ, with whitespace made visible.
function diffHtml(expected, actual) {
  const d = firstDifference(expected, actual);
  if (!d) return '';
  if (d.kind === 'missing') {
    return `<div class="diff"><b>Your output stops early.</b> Line ${d.line} should be: <code>${esc(visible(d.expected))}</code></div>`;
  }
  if (d.kind === 'extra') {
    return `<div class="diff"><b>Your output has extra lines.</b> Line ${d.line} should not be there: <code>${esc(visible(d.actual))}</code></div>`;
  }
  const mark = (s) => {
    const v = visible(s);
    const head = esc(v.slice(0, d.index));
    const ch = v[d.index];
    return ch === undefined ? `${head}<mark>⏎</mark>` : `${head}<mark>${esc(ch)}</mark>${esc(v.slice(d.index + 1))}`;
  };
  return `<div class="diff"><b>First difference: line ${d.line}, column ${d.index + 1}</b>
    <div>Expected <code>${mark(d.expected)}</code></div><div>Yours <code>${mark(d.actual)}</code></div>
    ${d.spacingOnly ? '<div class="hint">Only the spacing differs. Spaces inside a line (shown as ·) must match exactly; only trailing spaces are ignored.</div>' : ''}</div>`;
}

const SKIP_NOTE = '<div class="hint">The grader only shows the start of this test\'s input, so it can\'t be run here. Submit to check it.</div>';
const PARTIAL_NOTE = '<div class="hint">The grader only shows the start of the expected output, so only those lines were checked.</div>';

// results: from runTests(); cases: [{input, output, partialInput?, partialOutput?}]
function localResultsHtml(problem, cases, results) {
  const passed = results.filter((r) => r.verdict === 'PASS').length;
  const skipped = results.filter((r) => r.verdict === 'SKIP').length;
  const firstBad = results.findIndex((r) => r.verdict !== 'PASS' && r.verdict !== 'SKIP');
  const rows = results.map((r, i) => {
    const tc = cases[i];
    const cmp = comparedOutputs(tc, r.stdout);
    const extra = r.verdict === 'FAIL' ? diffHtml(cmp.expected, cmp.actual)
      : r.verdict === 'TLE' ? '<div class="diff"><b>Time limit exceeded.</b> Your program did not finish in time.</div>'
        : r.verdict === 'SKIP' ? SKIP_NOTE : '';
    return `<details ${i === firstBad ? 'open' : ''}>
      <summary><span class="v ${r.verdict}">${r.verdict}</span> Test ${i + 1} <span class="ms">${r.ms} ms</span></summary>
      ${extra}${tc.partialOutput && r.verdict !== 'SKIP' ? PARTIAL_NOTE : ''}
      <div class="grid">
        <div><h4>Input</h4><pre>${esc(clip(tc.input))}</pre></div>
        <div><h4>Expected</h4><pre>${esc(clip(tc.output))}</pre></div>
        <div><h4>Your output</h4><pre>${esc(clip(r.stdout))}</pre></div>
      </div>${r.stderr ? `<h4>stderr</h4><pre class="err">${esc(clip(r.stderr))}</pre>` : ''}
    </details>`;
  }).join('');
  const files = cases[0] && cases[0].files ? Object.keys(cases[0].files) : [];
  const filesNote = files.length ? `<div class="ms">Data files from the grader: ${files.map(esc).join(', ')}. Paths like /data/${esc(files[0])} in the input point to them.</div>` : '';
  return page(`<div class="sum"><b>${esc(problem.code)}</b> — ${passed}/${results.length - skipped} passed${skipped ? ` <span class="ms">(${skipped} skipped)</span>` : ''}</div>${filesNote}${rows}`);
}

// one run with a chosen test's input or custom input; expected is optional
function singleResultHtml(title, input, expected, r) {
  const verdict = expected === undefined || r.verdict !== 'OK' ? r.verdict
    : firstDifference(expected, r.stdout) ? 'FAIL' : 'PASS';
  const extra = verdict === 'FAIL' ? diffHtml(expected, r.stdout)
    : verdict === 'TLE' ? '<div class="diff"><b>Time limit exceeded.</b></div>' : '';
  return page(`<div class="sum"><span class="v ${verdict}">${verdict}</span> ${esc(title)} <span class="ms">${r.ms} ms</span></div>${extra}
    <div class="grid">
      <div><h4>Input</h4><pre>${esc(clip(input))}</pre></div>
      ${expected === undefined ? '' : `<div><h4>Expected</h4><pre>${esc(clip(expected))}</pre></div>`}
      <div><h4>Your output</h4><pre>${esc(clip(r.stdout))}</pre></div>
    </div>${r.stderr ? `<h4>stderr</h4><pre class="err">${esc(clip(r.stderr))}</pre>` : ''}`);
}

// grader result from parseSubmissionPage()
function submissionHtml(problem, id, g) {
  const tiles = g.tests.map((t) => `<span class="tile ${/correct/i.test(t.label) ? 'ok' : 'bad'}" title="Test ${t.n}: ${esc(t.label)}">${esc(t.letter)}</span>`).join('');
  const state = g.timedOut ? 'Still grading after 90 s - check the grader site'
    : g.done ? `${g.points ?? '?'} / ${g.max ?? '?'} points` : `Grading... (${esc(g.status || 'queued')})`;
  return page(`<div class="sum"><b>${esc(problem.code)}</b> submitted as #${esc(id)}</div>
    <div class="sum">${state}</div><div class="tiles">${tiles}</div>
    ${g.runtime ? `<div class="ms">Runtime ${esc(g.runtime)}</div>` : ''}
    <div class="hint">Hover a tile for the verdict of that test on the grader.</div>`);
}

const emptyHtml = () => page('Save a linked solution file (or press ▶) to see test results here.');

// Minimal, safe formatting for the model's plain-text reply: escape first, then wrap
// ``` fences and `code` spans and split into paragraphs. Never trusts the text as HTML.
// Fenced code is pulled out before paragraph/newline handling (as a placeholder) so its
// own newlines aren't turned into <br>, then spliced back in.
function mdLite(text) {
  const blocks = [];
  const withPlaceholders = esc(text).replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${code.replace(/\n$/, '')}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const html = withPlaceholders
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')}</p>`)
    .join('');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// An AI explanation of a test failure (see lib/aiExplain.js). `note` is an optional warning
// (e.g. the file was edited since this run), shown above the explanation.
function explanationHtml(title, note, text) {
  return page(`<div class="sum">✨ ${esc(title)}</div>
    ${note ? `<div class="hint">${esc(note)}</div>` : ''}
    <div class="ai">${mdLite(text)}</div>
    <div class="hint" style="margin-top:12px">AI explanations can be wrong, and this one only explains the bug - it will not write the fix for you.</div>`);
}

module.exports = { localResultsHtml, singleResultHtml, submissionHtml, explanationHtml, emptyHtml, diffHtml, esc };
