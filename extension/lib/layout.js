'use strict';
// Where solution files go in the workspace.
const path = require('path');

// A file or folder name made from a problem code. Never "." or ".." (or empty), which would point outside.
const safeName = (s) => {
  const name = s.replace(/[^\w\-.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return !name || /^\.+$/.test(name) ? 'problem' : name;
};

// Exam practice problems, e.g. 2025s1_Exam2_A1-1_Student or Exam1-2024_Q1A_student (not "Example").
const isExam = (s) => /(?<![a-z])exam(?![a-z])/i.test(s);
const EXAM_NUMBER = /(?<![a-z])exam[\s_-]*(\d+)/i;

// 05_List_15 -> 05_List; exam problems go together by exam number: Exam1, Exam2, ... Also the sidebar's grouping.
const chapterOf = (code) => {
  const exam = EXAM_NUMBER.exec(code);
  if (exam) return `Exam${Number(exam[1])}`;
  if (isExam(code)) return 'Exam';
  return code.split('_').slice(0, 2).join('_') || code;
};

// New solution file: <root>/<chapter>/<code><ext>, or <root>/<code><ext> when byChapter is off.
function solutionPath(root, code, ext, byChapter = true) {
  if (!ext.startsWith('.')) ext = '.' + ext;
  const file = `${safeName(code)}${ext}`;
  return byChapter ? path.join(root, safeName(chapterOf(code)), file) : path.join(root, file);
}

module.exports = { safeName, chapterOf, solutionPath, isExam };
