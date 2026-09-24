const path = require('path');
const vscode = require('vscode');

// Webview HTML for the PDF statement viewer (pdf.js, zoom + right-drag pan).
function statementHtml(webview, statementPath, libDir) {
  const pdfUri = webview.asWebviewUri(vscode.Uri.file(statementPath));
  const pdfJsUri = webview.asWebviewUri(vscode.Uri.file(path.join(libDir, 'pdf.min.js')));
  const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.file(path.join(libDir, 'pdf.worker.min.js')));
  const csp = webview.cspSource;

  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${csp} 'unsafe-inline'; connect-src ${csp}; img-src ${csp} data:; style-src 'unsafe-inline'; worker-src ${csp} blob:;">
<style>
  html, body { margin: 0; padding: 0; background: #525659; height: 100%; }
  body { overflow: auto; }
  #toolbar {
    position: sticky; top: 0; left: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; background: #333; color: #ddd;
    font-family: sans-serif; font-size: 12px;
  }
  #toolbar button {
    cursor: pointer; background: #555; color: #fff; border: none;
    border-radius: 3px; width: 24px; height: 24px; font-size: 14px;
  }
  #toolbar button:hover { background: #666; }
  #container { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px; width: fit-content; margin: 0 auto; }
  canvas { box-shadow: 0 2px 8px rgba(0,0,0,0.5); display: block; }
  #status { color: #ddd; font-family: sans-serif; padding: 16px; }
</style>
</head>
<body>
<div id="toolbar" style="display:none;">
  <button id="zoomOut">-</button>
  <span id="zoomLabel">150%</span>
  <button id="zoomIn">+</button>
</div>
<div id="status">Loading statement...</div>
<div id="container"></div>
<script src="${pdfJsUri}"></script>
<script>
  const pdfjsLib = window['pdfjs-dist/build/pdf'];

  const statusEl = document.getElementById('status');
  const container = document.getElementById('container');
  const toolbar = document.getElementById('toolbar');
  const zoomLabel = document.getElementById('zoomLabel');

  const loadTimeout = setTimeout(() => {
    statusEl.textContent = 'Still loading after 8s. Check Developer: Open Webview Developer Tools for errors.';
  }, 8000);

  let pdfDoc = null;
  let scale = 1.5;
  let canvases = [];

  function scrollEl() {
    return document.scrollingElement || document.documentElement;
  }

  // Renders into brand-new canvases off to the side, then swaps them in only
  // once fully drawn — avoids ever showing a blank/cleared canvas mid-render.
  async function renderAll() {
    zoomLabel.textContent = Math.round((scale / 1.5) * 100) + '%';

    const pages = await Promise.all(
      Array.from({ length: pdfDoc.numPages }, (_, i) => pdfDoc.getPage(i + 1))
    );
    const viewports = pages.map((p) => p.getViewport({ scale }));

    const newCanvases = viewports.map((vp) => {
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      return c;
    });

    await Promise.all(
      pages.map((page, i) =>
        page.render({ canvasContext: newCanvases[i].getContext('2d'), viewport: viewports[i] }).promise
      )
    );

    canvases.forEach((c) => c.remove());
    newCanvases.forEach((c) => container.appendChild(c));
    canvases = newCanvases;
  }

  // Zooms while keeping the content under (clientX, clientY) fixed in place.
  async function zoomTo(newScale, clientX, clientY) {
    const el = scrollEl();
    const oldScale = scale;
    const contentX = (el.scrollLeft + clientX) / oldScale;
    const contentY = (el.scrollTop + clientY) / oldScale;

    scale = newScale;
    await renderAll();

    el.scrollLeft = contentX * scale - clientX;
    el.scrollTop = contentY * scale - clientY;
  }

  document.getElementById('zoomIn').addEventListener('click', () => {
    zoomTo(Math.min(scale * 1.2, 6), window.innerWidth / 2, window.innerHeight / 2);
  });
  document.getElementById('zoomOut').addEventListener('click', () => {
    zoomTo(Math.max(scale / 1.2, 0.3), window.innerWidth / 2, window.innerHeight / 2);
  });
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const newScale = e.deltaY < 0 ? Math.min(scale * 1.1, 6) : Math.max(scale / 1.1, 0.3);
    zoomTo(newScale, e.clientX, e.clientY);
  }, { passive: false });

  // Right-click-drag to pan.
  let isPanning = false;
  let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    const el = scrollEl();
    isPanning = true;
    panStart = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    document.body.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const el = scrollEl();
    el.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
    el.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
  });

  function stopPanning() {
    isPanning = false;
    document.body.style.cursor = 'default';
  }
  document.addEventListener('mouseup', stopPanning);
  window.addEventListener('blur', stopPanning);

  (async () => {
    try {
      const workerBlob = await fetch("${pdfWorkerUri}").then((r) => r.blob());
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

      const pdfArrayBuffer = await fetch("${pdfUri}").then((r) => r.arrayBuffer());
      pdfDoc = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;

      clearTimeout(loadTimeout);
      statusEl.remove();
      toolbar.style.display = 'flex';
      await renderAll();
    } catch (err) {
      clearTimeout(loadTimeout);
      statusEl.textContent = 'Failed to load statement: ' + err.message;
    }
  })();
</script>
</body>
</html>`;
}

module.exports = { statementHtml };
