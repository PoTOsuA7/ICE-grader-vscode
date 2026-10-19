'use strict';
// Puts a PNG picture on the system clipboard. VS Code's clipboard API only does text; this is for statements whose
// text is drawn rather than written, which can only be copied as a picture.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// -> [command, args, extra env] that copies the PNG file `file` to the clipboard on this platform. The path goes
// in an environment variable, so no quoting is needed.
function clipboardCommand(platform, file, env = process.env) {
  const vars = { NATTEE_PNG: file };
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [System.Drawing.Image]::FromFile($env:NATTEE_PNG); '
      + '[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()'], vars];
  }
  if (platform === 'darwin') {
    return ['osascript', ['-e', 'set the clipboard to (read (POSIX file (system attribute "NATTEE_PNG")) as «class PNGf»)'], vars];
  }
  if (env.WAYLAND_DISPLAY) return ['sh', ['-c', 'wl-copy --type image/png < "$NATTEE_PNG"'], vars];
  return ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file], vars];
}

function run(cmd, args, env, platform) {
  return new Promise((resolve, reject) => {
    // On Linux xclip / wl-copy stay in the background to serve the clipboard: don't wait on their output.
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'ignore', platform === 'linux' ? 'ignore' : 'pipe'] });
    let err = '';
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} took too long`)); }, 20000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `${cmd} is not installed` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(err.trim().split('\n')[0] || `${cmd} failed (exit code ${code})`));
    });
  });
}

async function copyPngToClipboard(png, { platform = process.platform, exec = run } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nattee-clip-'));
  const file = path.join(dir, 'statement.png');
  try {
    fs.writeFileSync(file, png);
    const [cmd, args, env] = clipboardCommand(platform, file);
    await exec(cmd, args, env, platform);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { copyPngToClipboard, clipboardCommand };
