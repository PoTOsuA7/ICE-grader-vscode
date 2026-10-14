'use strict';
// Shared by the tests that really run Python.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSingle } = require('../lib/runner');

// true if Python 3 can run here. Skips only when Python is genuinely missing on a developer machine: in CI
// (which installs Python) or for any other error it fails, so a runner bug can't hide as "skipped".
async function havePython(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-probe-'));
  const f = path.join(dir, 'probe.py');
  fs.writeFileSync(f, 'print(1)');
  try {
    const r = await runSingle(f, '', { pythonPath: 'python', timeoutMs: 10000 });
    if (r.verdict !== 'OK' || r.stdout.trim() !== '1') throw new Error(`Python probe failed: ${r.verdict} ${r.stderr}`);
    return true;
  } catch (e) {
    if (!process.env.CI && /Python 3 not found/.test(e.message)) { t.skip('no python'); return false; }
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { havePython };
