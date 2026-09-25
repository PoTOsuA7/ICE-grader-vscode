'use strict';
// Output comparison shared by the runner (verdict) and the results view (explaining a mismatch).

// Same leniency as the grader: ignore CRLF, trailing spaces per line, trailing blank lines.
function normLines(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const normalize = (s) => normLines(s).join('\n');

// -> null when equal, else { line, kind: 'missing'|'extra'|'differs', expected?, actual?, index?, spacingOnly? }
function firstDifference(expected, actual) {
  const e = normLines(expected);
  const a = normLines(actual);
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    if (e[i] === undefined) return { line: i + 1, kind: 'extra', actual: a[i] };
    if (a[i] === undefined) return { line: i + 1, kind: 'missing', expected: e[i] };
    let index = 0;
    while (index < e[i].length && index < a[i].length && e[i][index] === a[i][index]) index++;
    const collapse = (s) => s.replace(/\s+/g, ' ').trim();
    return {
      line: i + 1, kind: 'differs', expected: e[i], actual: a[i], index,
      spacingOnly: collapse(e[i]) === collapse(a[i]),
    };
  }
  return null;
}

// Make whitespace visible so "Hello  Python." vs "Hello Python." can be seen.
const visible = (s) => s.replace(/ /g, '·').replace(/\t/g, '→').replace(/\r/g, '␍');

module.exports = { normLines, normalize, firstDifference, visible };
