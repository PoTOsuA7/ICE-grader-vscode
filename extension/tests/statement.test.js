'use strict';
// The statement viewer's own script, run against a stub page and a stub pdf.js (no VS Code, no browser).
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'vscode') return { Uri: { file: (p) => ({ p }) } };
  return realLoad.call(this, req, ...a);
};
const { statementHtml } = require('../lib/statement');
Module._load = realLoad;

function startViewer({ msPerArea }) {
  const html = statementHtml({ asWebviewUri: (u) => 'vs://' + u.p, cspSource: 'vs:' }, 'x.pdf', 'lib');
  const src = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const listeners = {};
  const el = (id) => ({ id, textContent: '', style: {}, children: [], appendChild(c) { this.children.push(c); }, remove() {},
    addEventListener(t, f) { listeners[`${id}:${t}`] = f; } });
  const els = Object.fromEntries(['status', 'container', 'toolbar', 'zoomLabel', 'zoomIn', 'zoomOut'].map((id) => [id, el(id)]));
  const document = {
    getElementById: (id) => els[id],
    createElement: () => {
      const c = { width: 0, height: 0, getContext: () => ({}), remove() { els.container.children = els.container.children.filter((x) => x !== c); } };
      return c;
    },
    addEventListener: () => {}, scrollingElement: { scrollLeft: 0, scrollTop: 0 }, body: { style: {} },
  };
  // Bigger zoom = more pixels = slower render, like the real thing.
  const page = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: ({ viewport }) => ({ promise: new Promise((r) => setTimeout(r, viewport.width * viewport.height * msPerArea)) }),
  };
  const pdfDoc = { numPages: 3, getPage: async () => page };
  const window = {
    'pdfjs-dist/build/pdf': { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdfDoc) }) },
    innerWidth: 800, innerHeight: 600, addEventListener: (t, f) => { listeners[`window:${t}`] = f; },
  };
  const fetch = async () => ({ blob: async () => ({}), arrayBuffer: async () => new ArrayBuffer(1) });
  new Function('window', 'document', 'fetch', 'URL', 'setTimeout', 'clearTimeout', src)(
    window, document, fetch, { createObjectURL: () => 'blob:x' }, setTimeout, clearTimeout);
  return { els, listeners };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('quick zooming ends on the last zoom level, even when an older render finishes last', async () => {
  const v = startViewer({ msPerArea: 1 / 4000 });
  await wait(400); // first render at 100%
  for (let i = 0; i < 4; i++) {
    v.listeners['window:wheel']({ ctrlKey: true, deltaY: 1, clientX: 100, clientY: 100, preventDefault() {} });
    await wait(16);
  }
  await wait(1500);
  const expectedWidth = 600 * 1.5 / 1.1 ** 4;
  assert.strictEqual(v.els.zoomLabel.textContent, '68%');
  assert.deepStrictEqual(v.els.container.children.map((c) => c.width.toFixed(1)), Array(3).fill(expectedWidth.toFixed(1)));
});
