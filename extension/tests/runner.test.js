'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests, runSingle } = require('../lib/runner');

const cfg = { pythonPath: 'python', cppCompiler: 'g++', cCompiler: 'gcc', timeoutMs: 1500 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-test-'));
const write = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
const cases = [{ input: '2 3\n', output: '5\n' }, { input: '10 1\n', output: '11\n' }];
const verdicts = async (f, cs = cases) => (await runTests(f, cs, cfg)).map((r) => r.verdict);

// Skip the Python tests if there is no Python on this machine.
async function havePython() {
  try { await runSingle(write('probe.py', 'print(1)'), '', cfg); return true; } catch { return false; }
}

test('verdicts: PASS, FAIL, RE, TLE, and trailing whitespace is ignored', async (t) => {
  if (!(await havePython())) return t.skip('no python');
  assert.deepStrictEqual(await verdicts(write('ok.py', 'a,b=map(int,input().split());print(a+b)')), ['PASS', 'PASS']);
  assert.deepStrictEqual(await verdicts(write('bad.py', 'a,b=map(int,input().split());print(a*b)')), ['FAIL', 'FAIL']);
  assert.deepStrictEqual(await verdicts(write('crash.py', 'raise SystemExit(3)')), ['RE', 'RE']);
  assert.deepStrictEqual(await verdicts(write('ws.py', 'a,b=map(int,input().split());print(a+b,end="  \\n\\n")')), ['PASS', 'PASS']);
  assert.deepStrictEqual(await verdicts(write('slow.py', 'while True: pass'), [cases[0]]), ['TLE']);
});

test('non-ASCII output survives (UTF-8)', async (t) => {
  if (!(await havePython())) return t.skip('no python');
  const r = await runSingle(write('uni.py', 'print("★ สวัสดี")'), '', cfg);
  assert.strictEqual(r.verdict, 'OK');
  assert.strictEqual(r.stdout.trim(), '★ สวัสดี');
});

test('runSingle reports OK, RE and TLE', async (t) => {
  if (!(await havePython())) return t.skip('no python');
  assert.strictEqual((await runSingle(write('echo.py', 'print(input())'), 'hi\n', cfg)).stdout.trim(), 'hi');
  assert.strictEqual((await runSingle(write('boom.py', '1/0'), '', cfg)).verdict, 'RE');
  assert.strictEqual((await runSingle(write('hang.py', 'import time; time.sleep(60)'), '', cfg)).verdict, 'TLE');
});

test('a timeout also kills processes the solution started', async (t) => {
  if (!(await havePython())) return t.skip('no python');
  const beat = path.join(dir, 'beat.txt');
  const child = `import time\nn=0\nwhile True:\n    n+=1\n    open(r'${beat}','w').write(str(n))\n    time.sleep(0.05)`;
  const parent = `import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}])\ntime.sleep(60)`;
  const r = await runSingle(write('tree.py', parent), '', { ...cfg, timeoutMs: 1200 });
  assert.strictEqual(r.verdict, 'TLE');
  await new Promise((res) => setTimeout(res, 600)); // let any straggler settle
  const a = fs.readFileSync(beat, 'utf8');
  await new Promise((res) => setTimeout(res, 800));
  assert.strictEqual(fs.readFileSync(beat, 'utf8'), a, 'grandchild process is still running after the timeout');
});

test('unsupported file type gives a clear error', async () => {
  await assert.rejects(() => runTests(write('x.rs', ''), cases, cfg), /Unsupported file type/);
});
