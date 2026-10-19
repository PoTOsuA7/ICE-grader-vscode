'use strict';
// Mock exam: picking the problems, the clock and the score. Pure functions; the VS Code side is in extension.js.

// Problems for a mock, from the chosen groups: only ones with test cases (they are marked at the end),
// problems not solved yet first, each part in random order.
function pickProblems(problems, groups, count, groupOf, random = Math.random) {
  const pool = problems
    .filter((p) => p.hasTestcases !== false && groups.includes(groupOf(p)))
    .map((p) => [random(), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  return [...pool.filter((p) => p.status !== 'solved'), ...pool.filter((p) => p.status === 'solved')].slice(0, count);
}

const pad = (n) => String(n).padStart(2, '0');

// Time left as on a clock: 4500000 -> "1:15:00", 59000 -> "0:59". Never negative.
function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Folder name for a mock started at `date`: 2026-10-17_1432
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;

// items: [{ code, results?, note? }] (note = why it wasn't marked: not attempted, compile error, ...).
// Every problem counts the same, by the share of its tests that pass; skipped tests count neither way.
function summarize(items) {
  const per = items.map((it) => {
    const results = it.results || [];
    const ran = results.filter((r) => r.verdict !== 'SKIP').length;
    const passed = results.filter((r) => r.verdict === 'PASS').length;
    return { ...it, passed, ran, fraction: ran ? passed / ran : 0 };
  });
  const percent = per.length ? Math.round((100 * per.reduce((a, x) => a + x.fraction, 0)) / per.length) : 0;
  return { per, percent };
}

module.exports = { pickProblems, clock, stamp, summarize };
