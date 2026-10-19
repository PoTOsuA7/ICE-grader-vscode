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

function startViewer({ msPerArea, numPages = 3 }) {
  const html = statementHtml({ asWebviewUri: (u) => 'vs://' + u.p, cspSource: 'vs:' }, 'x.pdf', 'lib');
  const src = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const listeners = {};
  const el = (id) => ({ id, textContent: '', style: {}, children: [], appendChild(c) { this.children.push(c); }, remove() {},
    addEventListener(t, f) { listeners[`${id}:${t}`] = f; } });
  const els = Object.fromEntries(['status', 'container', 'toolbar', 'zoomLabel', 'zoomIn', 'zoomOut'].map((id) => [id, el(id)]));
  const document = {
    getElementById: (id) => els[id],
    createElement: () => {
      const ctx = { drawn: [], fillRect() {}, drawImage(img, x, y) { ctx.drawn.push([img.width, img.height, x, y]); } };
      const c = {
        width: 0, height: 0, getContext: () => ctx, toDataURL: (type) => `data:${type};base64,${c.width}x${c.height}:${JSON.stringify(ctx.drawn)}`,
        remove() { els.container.children = els.container.children.filter((x) => x !== c); },
      };
      return c;
    },
    addEventListener: () => {}, scrollingElement: { scrollLeft: 0, scrollTop: 0 }, body: { style: {} },
  };
  // Bigger zoom = more pixels = slower render, like the real thing.
  const page = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: ({ viewport }) => ({ promise: new Promise((r) => setTimeout(r, viewport.width * viewport.height * msPerArea)) }),
  };
  page.getTextContent = async () => ({ items: [{ str: 'Line one', hasEOL: true }, { str: 'Line ', hasEOL: false }, { str: 'two', hasEOL: false }] });
  const pdfDoc = { numPages, getPage: async () => page };
  const posted = [];
  const window = {
    'pdfjs-dist/build/pdf': { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdfDoc) }) },
    innerWidth: 800, innerHeight: 600, addEventListener: (t, f) => { listeners[`window:${t}`] = f; },
  };
  const fetch = async () => ({ blob: async () => ({}), arrayBuffer: async () => new ArrayBuffer(1) });
  new Function('window', 'document', 'fetch', 'URL', 'setTimeout', 'clearTimeout', 'acquireVsCodeApi', src)(
    window, document, fetch, { createObjectURL: () => 'blob:x' }, setTimeout, clearTimeout, () => ({ postMessage: (m) => posted.push(m) }));
  return { els, listeners, posted };
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

test('asked for the text (the Copy button), the viewer sends the PDF text page by page, even if asked while loading', async () => {
  const v = startViewer({ msPerArea: 0 });
  v.listeners['window:message']({ data: { type: 'getText', id: 7 } }); // before the PDF has loaded
  v.listeners['window:message']({ data: { type: 'zoom' } }); // other messages are not for it
  await wait(100);
  const page = 'Line one\nLine two';
  assert.deepStrictEqual(v.posted, [{ type: 'text', id: 7, pages: [page, page, page] }]);
});

const picture = async (numPages) => {
  const v = startViewer({ msPerArea: 0, numPages });
  await wait(50);
  v.listeners['window:message']({ data: { type: 'getImage', id: 8 } });
  for (let t = 0; t < 100 && !v.posted.length; t++) await wait(20);
  assert.strictEqual(v.posted.length, 1);
  const [, size, drawn] = /^data:image\/png;base64,(\d+x\d+):(.*)$/.exec(v.posted[0].png);
  return { size, drawn: JSON.parse(drawn) };
};

test('asked for a picture, the viewer draws every page at twice the size, side by side so it stays about square', async () => {
  // pages of 600 x 800 at scale 2 (1200 x 1600 each)
  assert.deepStrictEqual(await picture(1), { size: '1200x1600', drawn: [[1200, 1600, 0, 0]] });
  assert.deepStrictEqual(await picture(2), { size: '2400x1600', drawn: [[1200, 1600, 0, 0], [1200, 1600, 1200, 0]] });
  assert.deepStrictEqual(await picture(3), { size: '2400x3200', drawn: [[1200, 1600, 0, 0], [1200, 1600, 1200, 0], [1200, 1600, 0, 1600]] });
});

test('a statement with many pages becomes a grid, smaller so it is at most 4000 px a side, with every page in it', async () => {
  const { size, drawn } = await picture(13);
  // 4 across, 4 down (the last row has one page), at scale 4000 / 3200 = 1.25 (750 x 1000 a page)
  assert.strictEqual(size, '3000x4000');
  assert.strictEqual(drawn.length, 13);
  assert.deepStrictEqual(drawn[5], [750, 1000, 750, 1000]);
  assert.deepStrictEqual(drawn[12], [750, 1000, 0, 3000]);
});
