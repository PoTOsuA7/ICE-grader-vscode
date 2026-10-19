'use strict';
// The Run in Terminal terminal, with real programs (small Node scripts run by this same Node).
const test = require('node:test');
const assert = require('node:assert');
const { programTerminal } = require('../lib/programTerminal');
const { killTree } = require('../lib/runner');

// Opens a terminal running `code`, types `keys`; resolves once the program has ended, with what was shown.
function run(code, keys = [], opts = {}) {
  return new Promise((resolve) => {
    let shown = '';
    let exits = 0;
    const pty = programTerminal({
      cmd: process.execPath, args: ['-e', code], intro: 'Running x.py: type the input', ...opts,
      onExit: () => { exits++; setTimeout(() => resolve({ shown: () => shown, exits: () => exits, pty }), 50); },
    });
    pty.onDidWrite((s) => { shown += s; });
    pty.open();
    for (const k of keys) pty.handleInput(k);
    if (opts.after) opts.after(pty);
  });
}
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const READ_TWO = `const rl = require('readline').createInterface({ input: process.stdin }); const got = [];
rl.on('line', (l) => { got.push(l); if (got.length === 2) {
  console.log('got ' + got.join('|')); console.error('Traceback: ValueError'); rl.close(); process.stdin.destroy(); process.exitCode = 1; } });`;

test('typed lines go to the program; its output and its error stay on screen after it ends', async () => {
  const keys = ['A', 'A', 'X', '\x7f', 'A', '\r', 'สวัสดี', '\r'];
  const r = await run(READ_TWO, keys);
  const shown = r.shown();
  assert.match(shown, /^\x1b\[2mRunning x\.py: type the input/, 'says what to do first');
  assert.ok(shown.includes('AAX\b \bA\r\n'), 'typing is echoed, backspace rubs out');
  assert.match(shown, /got AAA\|สวัสดี\r\n/, 'Thai text both ways');
  assert.match(shown, /\x1b\[31mTraceback: ValueError/, 'errors in red');
  assert.match(plain(shown), /--- program ended with an error \(exit code 1\)\. Run in Terminal again to restart it\. ---/);
  assert.strictEqual(r.exits(), 1);
  r.pty.handleInput('more\r');
  r.pty.close();
  assert.strictEqual(r.shown(), shown, 'nothing more once it has ended, and the terminal stays until closed');
  assert.strictEqual(r.exits(), 1);
});

test('a paste of several lines is several Enters; Ctrl+D or Ctrl+Z ends the input', async () => {
  const ALL = `let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => console.log(JSON.stringify(s)));`;
  const d = await run(ALL, ['3\r4\r\n5\r', '6', '\x04']);
  assert.ok(d.shown().includes('"3\\n4\\n5\\n6"'), d.shown());
  assert.match(plain(d.shown()), /\^D\r\n[\s\S]*--- program finished\./);
  const z = await run(ALL, ['7\r', '\x1a']);
  assert.ok(z.shown().includes('"7\\n"'), z.shown());
});

test('Ctrl+C, or closing the terminal, stops a program that is waiting for input', async () => {
  const WAIT = 'process.stdin.resume()';
  for (const kill of [undefined, killTree]) {
    const c = await run(WAIT, [], { kill, after: (pty) => setTimeout(() => pty.handleInput('\x03'), 200) });
    assert.match(plain(c.shown()), /\^C\r\n[\s\S]*--- program stopped\./);
    const x = await run(WAIT, [], { kill, after: (pty) => setTimeout(() => pty.close(), 200) });
    assert.match(plain(x.shown()), /--- program stopped\./);
    assert.strictEqual(x.exits(), 1);
  }
});

test('arrow keys are ignored; a program that can\'t start says so; closing before it opens still cleans up', async () => {
  const r = await run(READ_TWO, ['1', '\x1b[A', '\x1b[D', '\r', '2\r']);
  assert.match(r.shown(), /got 1\|2/);
  const bad = await run('', [], { cmd: 'no-such-program-nattee' });
  assert.match(plain(bad.shown()), /Could not start "no-such-program-nattee"/);
  let cleaned = 0;
  programTerminal({ cmd: 'x', onExit: () => { cleaned++; } }).close();
  assert.strictEqual(cleaned, 1);
});
