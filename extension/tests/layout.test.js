'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { chapterOf, solutionPath, safeName, isExam } = require('../lib/layout');

test('chapterOf takes the first two parts of the code', () => {
  assert.strictEqual(chapterOf('05_List_15'), '05_List');
  assert.strictEqual(chapterOf('03_If_001'), '03_If');
  assert.strictEqual(chapterOf('P1_07_Biorhythm'), 'P1_07');
  assert.strictEqual(chapterOf('solo'), 'solo');
});

test('exam practice problems are grouped by exam number', () => {
  assert.strictEqual(chapterOf('2025s1_Exam2_A1-1_Student'), 'Exam2');
  assert.strictEqual(chapterOf('Exam1-2024_Q1A_student'), 'Exam1');
  assert.strictEqual(chapterOf('Exam_01'), 'Exam1');
  assert.strictEqual(chapterOf('2026s1_Exam3_A1-1_Student'), 'Exam3');
  assert.strictEqual(chapterOf('Final_Exam_Q1'), 'Exam');
  assert.strictEqual(chapterOf('08_Example_01'), '08_Example', '"Example" is not an exam');
  assert.ok(isExam('Exam1-2024_Q1A_student') && isExam('2025s1_Exam2_B4-1_Student') && !isExam('08_Example_01'));
  assert.strictEqual(solutionPath('ws', 'Exam1-2024_Q1A_student', '.py'), path.join('ws', 'Exam1', 'Exam1-2024_Q1A_student.py'));
});

test('solutionPath puts the file in its chapter folder by default', () => {
  const root = path.join('ws');
  assert.strictEqual(solutionPath(root, '05_List_15', '.py'), path.join('ws', '05_List', '05_List_15.py'));
  assert.strictEqual(solutionPath(root, '01_Expr_02', 'cpp'), path.join('ws', '01_Expr', '01_Expr_02.cpp'));
});

test('solutionPath can keep files flat in the workspace root', () => {
  assert.strictEqual(solutionPath('ws', '05_List_15', '.py', false), path.join('ws', '05_List_15.py'));
});

test('odd characters in a code become safe file and folder names', () => {
  assert.strictEqual(safeName('a b/c'), 'a_b_c');
  assert.strictEqual(solutionPath('ws', '06 Func_01', '.py'), path.join('ws', '06_Func_01', '06_Func_01.py'));
});

test('a problem code made of dots can never point outside the workspace', () => {
  for (const code of ['..', '..__x', '.', '...', '._.']) {
    for (const byChapter of [true, false]) {
      const file = path.resolve(solutionPath('ws', code, '.py', byChapter));
      assert.ok(file.startsWith(path.resolve('ws') + path.sep), `${code} -> ${file}`);
    }
  }
});
