'use strict';
// Where solution files go in the workspace.
const path = require('path');

const safeName = (s) => s.replace(/[^\w\-.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'problem';

// 05_List_15 -> 05_List. Also the sidebar's chapter grouping.
const chapterOf = (code) => code.split('_').slice(0, 2).join('_') || code;

// New solution file: <root>/<chapter>/<code><ext>, or <root>/<code><ext> when byChapter is off.
function solutionPath(root, code, ext, byChapter = true) {
  if (!ext.startsWith('.')) ext = '.' + ext;
  const file = `${safeName(code)}${ext}`;
  return byChapter ? path.join(root, safeName(chapterOf(code)), file) : path.join(root, file);
}

module.exports = { safeName, chapterOf, solutionPath };
