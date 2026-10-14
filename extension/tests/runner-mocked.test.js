'use strict';
// Runner behaviour that depends on which programs exist, with child_process.execFile faked.
// node --test runs each file in its own process, so the fake doesn't leak into other tests.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');

// answers: { command: (args) => [err, stdout, stderr] } ; anything else is "not found"
function fakeExecFile(answers) {
  const calls = [];
  cp.execFile = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    if (cmd === '') throw Object.assign(new TypeError("The argument 'file' cannot be empty"), { code: 'ERR_INVALID_ARG_VALUE' });
    const a = answers[cmd];
    if (!a) return cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }), '', '');
    const [err, out, errOut] = a(args);
    return cb(err, out, errOut);
  };
  delete require.cache[require.resolve('../lib/runner')];
  return { calls, runner: require('../lib/runner') };
}

test('Python 2 is not accepted; the next candidate is tried', async () => {
  const { calls, runner } = fakeExecFile({
    python: () => [null, '', 'Python 2.7.18'],
    py: () => [null, 'Python 3.12.1', ''],
  });
  assert.strictEqual(await runner.findPython('python'), 'py');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['python', 'py']);
});

test('a Python setting that cannot even be started falls back instead of crashing', async () => {
  const { runner } = fakeExecFile({ python3: () => [null, 'Python 3.11.2', ''] });
  assert.strictEqual(await runner.findPython(''), 'python3');
  await assert.rejects(() => fakeExecFile({}).runner.findPython('python'), /Python 3 not found \(tried "python", "py", "python3"\)/);
});

test('C is linked with -lm (after the source), C++ is compiled as C++17', async () => {
  const { calls, runner } = fakeExecFile({});
  await assert.rejects(() => runner.prepare('/x/a.c', { cCompiler: 'gcc' }), /Compiler "gcc" not found/);
  await assert.rejects(() => runner.prepare('/x/a.cpp', { cppCompiler: '' }), /Compiler "g\+\+" not found/);
  const [c, cpp] = calls;
  assert.ok(c.indexOf('-lm') > c.indexOf('/x/a.c'), c.join(' '));
  assert.ok(cpp.includes('-std=c++17') && !cpp.includes('-lm'), cpp.join(' '));
});
