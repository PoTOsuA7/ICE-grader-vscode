'use strict';
// Compiles (if needed) and runs a solution file against grader test cases.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT = 1 << 20; // stop collecting after 1 MiB so an infinite printer can't eat memory

const { normalize } = require('./diff');

function execP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) =>
      resolve({ err, stdout, stderr }));
  });
}

// The Windows "python" command is often a Microsoft Store stub; fall back to the "py" launcher.
async function findPython(preferred) {
  for (const c of [preferred, 'py', 'python3']) {
    const r = await execP(c, ['--version'], { timeout: 10000 });
    if (!r.err && /Python \d/.test(r.stdout + r.stderr)) return c;
  }
  throw new Error(`Python not found (tried "${preferred}", "py", "python3"). Install Python or set nattee.pythonPath.`);
}

// -> { cmd, args, cleanup } or throws Error with a user-facing message
async function prepare(file, cfg) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return { cmd: await findPython(cfg.pythonPath), args: [file], cleanup() {} };
  if (ext === '.cpp' || ext === '.c') {
    const compiler = ext === '.c' ? cfg.cCompiler : cfg.cppCompiler;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-'));
    const exe = path.join(dir, process.platform === 'win32' ? 'sol.exe' : 'sol');
    const std = ext === '.c' ? [] : ['-std=c++17'];
    const r = await execP(compiler, [file, '-O2', ...std, '-o', exe]);
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    if (r.err) {
      cleanup();
      if (r.err.code === 'ENOENT') throw new Error(`Compiler "${compiler}" not found. Install it or set nattee.${ext === '.c' ? 'cCompiler' : 'cppCompiler'}.`);
      const e = new Error('Compilation failed');
      e.details = r.stderr || String(r.err);
      throw e;
    }
    return { cmd: exe, args: [], cleanup };
  }
  throw new Error(`Unsupported file type "${ext}" (supported: .py, .cpp, .c)`);
}

// Kill the process and everything it started. On Windows the "py" launcher runs python.exe as a child,
// so killing only the launcher would leave an infinite loop burning CPU.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

function runOne(cmd, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let out = '', err = '', timedOut = false, done = false;
    // UTF-8 so printing non-ASCII (★, Thai, ...) doesn't crash Python's default Windows codepage
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const child = spawn(cmd, args, { windowsHide: true, env, detached: process.platform !== 'win32' });
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, timedOut, ms: Date.now() - start, ...extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish({}), 1500); // don't hang if a grandchild keeps the pipes open
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // don't split multi-byte chars
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', (e) => finish({ spawnError: e.message }));
    child.on('close', (code) => finish({ code }));
    child.stdin.on('error', () => {}); // program exited without reading all input
    child.stdin.end(input);
  });
}

// -> [{ verdict: 'PASS'|'FAIL'|'TLE'|'RE', ms, stdout, stderr }]
async function runTests(file, cases, cfg) {
  const prep = await prepare(file, cfg);
  try {
    const results = [];
    for (const tc of cases) {
      const r = await runOne(prep.cmd, prep.args, tc.input, cfg.timeoutMs);
      if (r.spawnError) throw new Error(`Could not start "${prep.cmd}": ${r.spawnError}`);
      let verdict = 'PASS';
      if (r.timedOut) verdict = 'TLE';
      else if (r.code !== 0) verdict = 'RE';
      else if (normalize(r.stdout) !== normalize(tc.output)) verdict = 'FAIL';
      results.push({ verdict, ms: r.ms, stdout: r.stdout, stderr: r.stderr });
    }
    return results;
  } finally {
    prep.cleanup();
  }
}

// Run once with arbitrary input (no expected output). -> { verdict: 'OK'|'TLE'|'RE', ms, stdout, stderr }
async function runSingle(file, input, cfg) {
  const prep = await prepare(file, cfg);
  try {
    const r = await runOne(prep.cmd, prep.args, input, cfg.timeoutMs);
    if (r.spawnError) throw new Error(`Could not start "${prep.cmd}": ${r.spawnError}`);
    const verdict = r.timedOut ? 'TLE' : r.code !== 0 ? 'RE' : 'OK';
    return { verdict, ms: r.ms, stdout: r.stdout, stderr: r.stderr };
  } finally {
    prep.cleanup();
  }
}

module.exports = { runTests, runSingle, normalize };
