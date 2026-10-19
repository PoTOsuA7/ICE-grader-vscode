'use strict';
// A VS Code terminal that runs one program, like Thonny's shell: you type the input line by line, the output and
// any error stay on screen after the program ends (a plain terminal would close and take the error with it).
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Just enough of vscode.EventEmitter for a Pseudoterminal's events.
class Emitter {
  constructor() { this.listeners = []; this.event = (f) => { this.listeners.push(f); return { dispose: () => { this.listeners = this.listeners.filter((g) => g !== f); } }; }; }
  fire(x) { this.listeners.forEach((f) => f(x)); }
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// -> a vscode.Pseudoterminal. onExit runs once, when the program has ended (or could not start).
function programTerminal({ cmd, args = [], cwd, env = {}, intro = '', onExit = () => {}, kill = (child) => child.kill() }) {
  const write = new Emitter();
  const out = (s) => write.fire(s);
  let child = null;
  let running = false;
  let exited = false;
  let stopping = false; // stopped by Ctrl+C or by closing the terminal
  let line = ''; // what has been typed on the current line, sent with Enter
  let lastWasCR = false;
  const finish = () => { if (!exited) { exited = true; running = false; onExit(); } };

  function start() {
    if (intro) out(`${DIM}${crlf(intro)}${RESET}\r\n`);
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      out(`${RED}Could not start "${cmd}": ${e.message}${RESET}\r\n`);
      finish();
      return;
    }
    running = true;
    const so = new StringDecoder('utf8');
    const se = new StringDecoder('utf8');
    child.stdout.on('data', (d) => out(crlf(so.write(d))));
    child.stderr.on('data', (d) => out(`${RED}${crlf(se.write(d))}${RESET}`));
    child.stdin.on('error', () => {}); // the program ended while input was being sent
    child.on('error', (e) => {
      if (exited) return;
      out(`${RED}Could not start "${cmd}": ${e.message}${RESET}\r\n`);
      finish();
    });
    child.on('close', (code, signal) => {
      if (exited) return;
      const rest = so.end() + se.end();
      if (rest) out(crlf(rest));
      const how = stopping || signal || code === null ? 'stopped' : code === 0 ? 'finished' : `ended with an error (exit code ${code})`;
      out(`\r\n${DIM}--- program ${how}. Run in Terminal again to restart it. ---${RESET}\r\n`);
      finish();
    });
  }

  function send(text) {
    if (running && child.stdin.writable) child.stdin.write(Buffer.from(text, 'utf8'));
  }

  function handleInput(data) {
    if (!running) return;
    if (data.startsWith('\x1b')) return; // arrow keys and the like: no line editing beyond backspace
    for (const ch of data) {
      const cr = lastWasCR;
      lastWasCR = ch === '\r';
      if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && cr) continue; // \r\n from a paste is one Enter
        out('\r\n');
        send(`${line}\n`);
        line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) { line = Array.from(line).slice(0, -1).join(''); out('\b \b'); }
      } else if (ch === '\x03') { // Ctrl+C
        out('^C\r\n');
        stopping = true;
        kill(child);
        return;
      } else if (ch === '\x04' || ch === '\x1a') { // Ctrl+D / Ctrl+Z: end of input, for programs that read until it
        out(ch === '\x04' ? '^D\r\n' : '^Z\r\n');
        send(line);
        line = '';
        child.stdin.end();
      } else if (ch >= ' ' || ch === '\t') {
        line += ch;
        out(ch);
      }
    }
  }

  return {
    onDidWrite: write.event,
    open() { start(); },
    // the terminal was closed: stop the program if it is still running
    close() { if (running) { stopping = true; kill(child); } else finish(); },
    handleInput,
  };
}

module.exports = { programTerminal };
