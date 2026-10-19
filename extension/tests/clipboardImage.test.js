'use strict';
// Putting a picture on the clipboard: the command for each platform (none is run here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { copyPngToClipboard, clipboardCommand } = require('../lib/clipboardImage');

test('each platform gets its own clipboard command, with the picture path passed outside the command line', () => {
  const [win, winArgs, winEnv] = clipboardCommand('win32', 'C:/a b/s.png');
  assert.strictEqual(win, 'powershell.exe');
  assert.match(winArgs.at(-1), /Clipboard\]::SetImage/);
  assert.ok(!winArgs.join(' ').includes('a b'), 'no quoting needed for odd paths');
  assert.deepStrictEqual(winEnv, { NATTEE_PNG: 'C:/a b/s.png' });
  assert.strictEqual(clipboardCommand('darwin', '/t/s.png')[0], 'osascript');
  assert.strictEqual(clipboardCommand('linux', '/t/s.png', {})[0], 'xclip');
  assert.match(clipboardCommand('linux', '/t/s.png', { WAYLAND_DISPLAY: 'wayland-0' })[1].join(' '), /wl-copy --type image\/png/);
});

test('the picture is written to a temporary file for the command, which is removed afterwards, even on failure', async () => {
  let seen;
  await copyPngToClipboard(Buffer.from('PNGDATA'), { platform: 'win32', exec: async (cmd, args, env) => { seen = env.NATTEE_PNG; assert.strictEqual(fs.readFileSync(seen, 'utf8'), 'PNGDATA'); } });
  assert.strictEqual(fs.existsSync(seen), false);
  await assert.rejects(copyPngToClipboard(Buffer.from('x'), { platform: 'linux', exec: async (cmd, args, env) => { seen = env.NATTEE_PNG; throw new Error('xclip is not installed'); } }), /xclip is not installed/);
  assert.strictEqual(fs.existsSync(seen), false);
});
