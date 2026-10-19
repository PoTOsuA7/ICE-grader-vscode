'use strict';
// Compiles (if needed) and runs a solution file against grader test cases.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT = 1 << 20; // stop collecting after 1 MiB so an infinite printer can't eat memory
const EXIT_GRACE_MS = 300; // after the program exits, how long to wait for its output pipes to close

// Remove a temp folder without ever failing the run: on Windows a process that is still running (e.g. one the
// solution started and left behind) can keep it locked.
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* left for the OS */ } };

const { normalize, comparedOutputs } = require('./diff');

// Never rejects: a command that can't even be started (empty name, a .bat file, ...) comes back as { err }.
function execP(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 60000, windowsHide: true, ...opts }, (err, stdout, stderr) =>
        resolve({ err, stdout, stderr }));
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' });
    }
  });
}

// Thonny (the course's IDE) comes with its own Python, and a laptop with only Thonny has no other.
function thonnyPythons() {
  const env = process.env;
  const home = os.homedir();
  const mac = 'Thonny.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3';
  const places = process.platform === 'win32'
    ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Thonny', 'python.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Thonny', 'python.exe'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Thonny', 'python.exe')]
    : process.platform === 'darwin'
      ? [path.join('/Applications', mac), path.join(home, 'Applications', mac)]
      : [path.join(home, 'apps', 'thonny', 'bin', 'python3')];
  return places.filter((p) => p && fs.existsSync(p));
}

// The Windows "python" command is often a Microsoft Store stub; fall back to the "py" launcher, then Thonny's Python.
// Only Python 3 counts: the grader runs Python 3, and under Python 2 input() and print behave differently.
async function findPython(preferred, extras = thonnyPythons()) {
  const tried = [...new Set([preferred, 'py', 'python3', ...extras].filter(Boolean))];
  for (const c of tried) {
    const r = await execP(c, ['--version'], { timeout: 10000 });
    if (!r.err && /Python 3\./.test(r.stdout + r.stderr)) return c;
  }
  throw new Error(`Python 3 not found (tried ${tried.map((c) => `"${c}"`).join(', ')}). Install Python 3 (or Thonny) or set nattee.pythonPath.`);
}

// -> { cmd, args, cleanup } or throws Error with a user-facing message
async function prepare(file, cfg) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return { cmd: await findPython(cfg.pythonPath), args: [file], cleanup() {} };
  if (ext === '.cpp' || ext === '.c') {
    const compiler = (ext === '.c' ? cfg.cCompiler : cfg.cppCompiler) || (ext === '.c' ? 'gcc' : 'g++');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-'));
    const exe = path.join(dir, process.platform === 'win32' ? 'sol.exe' : 'sol');
    // C needs -lm on Linux for sqrt/pow/log (the grader links it too); g++ links it by itself.
    const args = ext === '.c' ? [file, '-O2', '-o', exe, '-lm'] : [file, '-O2', '-std=c++17', '-o', exe];
    const r = await execP(compiler, args);
    const cleanup = () => removeDir(dir);
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

// Data files: on the grader a problem's data files sit in /data/ and the test input names them by that
// absolute path (e.g. "/data/data.txt 2562"). Locally they're written to a temp folder, the program runs
// there, and "/data/<name>" in the input becomes the relative "data/<name>" (no drive letters or spaces).
// The files are also put next to the program's working directory under their bare name.
function dataSandbox(files) {
  if (!files || !Object.keys(files).length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-data-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    for (const [name, text] of Object.entries(files)) {
      const safe = path.basename(name); // never write outside the sandbox
      if (!safe || safe === '.' || safe === '..') continue;
      fs.writeFileSync(path.join(dir, 'data', safe), text);
      if (safe !== 'data') fs.writeFileSync(path.join(dir, safe), text); // "data" is the folder itself
    }
  } catch (e) {
    removeDir(dir);
    throw e;
  }
  return { dir, cleanup: () => removeDir(dir) };
}

function mapDataPaths(input, files) {
  if (!files) return input;
  let out = input;
  for (const name of Object.keys(files)) out = out.split(`/data/${name}`).join(`data/${path.basename(name)}`);
  return out;
}

const DEFAULT_TIMEOUT_MS = 3000;

function runOne(cmd, args, input, timeoutMs, cwd) {
  // 0, negative or not a number (e.g. an emptied setting) would time out at once: use the default instead.
  if (!(timeoutMs > 0)) timeoutMs = DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const start = Date.now();
    let out = '', err = '', timedOut = false, done = false, exitCode;
    // UTF-8 so printing non-ASCII (★, Thai, ...) doesn't crash Python's default Windows codepage
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const child = spawn(cmd, args, { windowsHide: true, env, cwd, detached: process.platform !== 'win32' });
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
    // Normally 'close' follows 'exit' at once. If the program started something that still holds its output
    // open, don't wait for the time limit: end the run with the program's own exit code and stop the leftovers.
    child.on('exit', (code) => {
      exitCode = code;
      setTimeout(() => {
        if (done) return;
        killTree(child);
        child.stdout.destroy(); child.stderr.destroy();
        finish({ code });
      }, EXIT_GRACE_MS);
    });
    child.on('close', (code) => finish({ code: exitCode !== undefined ? exitCode : code }));
    child.stdin.on('error', () => {}); // program exited without reading all input
    child.stdin.end(input);
  });
}

// -> [{ verdict: 'PASS'|'FAIL'|'TLE'|'RE'|'SKIP', ms, stdout, stderr, skipped? }]
// SKIP: the grader only shows the start of this test's input (skipped: 'input'), so it can't be run locally,
// or so little of the expected output that there is nothing to compare (skipped: 'output').
async function runTests(file, cases, cfg) {
  const prep = await prepare(file, cfg);
  try {
    const results = [];
    for (const tc of cases) {
      if (tc.partialInput) { results.push({ verdict: 'SKIP', skipped: 'input', ms: 0, stdout: '', stderr: '' }); continue; }
      const box = dataSandbox(tc.files);
      let r;
      try {
        r = await runOne(prep.cmd, prep.args, mapDataPaths(tc.input, tc.files), cfg.timeoutMs, box && box.dir);
      } finally { if (box) box.cleanup(); }
      if (r.spawnError) throw new Error(`Could not start "${prep.cmd}": ${r.spawnError}`);
      const cmp = comparedOutputs(tc, r.stdout);
      let verdict = 'PASS';
      if (r.timedOut) verdict = 'TLE';
      else if (r.code !== 0) verdict = 'RE';
      else if (cmp.unchecked) verdict = 'SKIP';
      else if (normalize(cmp.actual) !== normalize(cmp.expected)) verdict = 'FAIL';
      results.push({ verdict, ms: r.ms, stdout: r.stdout, stderr: r.stderr, ...(verdict === 'SKIP' ? { skipped: 'output' } : {}) });
    }
    return results;
  } finally {
    prep.cleanup();
  }
}

// What to start in a VS Code terminal so the student types the input themselves: { cmd, args, cleanup }.
// A terminal wants a real path, so for Python the interpreter's own path is used instead of "py"/"python".
async function terminalCommand(file, cfg) {
  const prep = await prepare(file, cfg);
  if (path.extname(file).toLowerCase() !== '.py') return prep;
  const r = await execP(prep.cmd, ['-c', 'import sys; print(sys.executable)'], { timeout: 10000 });
  const exe = !r.err && String(r.stdout).trim();
  return { ...prep, cmd: exe || prep.cmd };
}

// Run once with arbitrary input (no expected output), with the problem's data files if it has any.
// -> { verdict: 'OK'|'TLE'|'RE', ms, stdout, stderr }
async function runSingle(file, input, cfg, files) {
  const prep = await prepare(file, cfg);
  let box = null;
  try {
    box = dataSandbox(files);
    const r = await runOne(prep.cmd, prep.args, mapDataPaths(input, files), cfg.timeoutMs, box && box.dir);
    if (r.spawnError) throw new Error(`Could not start "${prep.cmd}": ${r.spawnError}`);
    const verdict = r.timedOut ? 'TLE' : r.code !== 0 ? 'RE' : 'OK';
    return { verdict, ms: r.ms, stdout: r.stdout, stderr: r.stderr };
  } finally {
    prep.cleanup();
    if (box) box.cleanup();
  }
}

module.exports = { runTests, runSingle, terminalCommand, dataSandbox, killTree, normalize, mapDataPaths, findPython, prepare }; // findPython and prepare: for tests
