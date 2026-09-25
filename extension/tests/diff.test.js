'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, firstDifference, visible } = require('../lib/diff');

test('normalize ignores CRLF, trailing spaces and trailing blank lines', () => {
  assert.strictEqual(normalize('a  \r\nb\t\r\n\r\n\r\n'), 'a\nb');
  assert.strictEqual(normalize(''), '');
});

test('equal outputs have no difference', () => {
  assert.strictEqual(firstDifference('1\n2\n', '1\r\n2   \n\n'), null);
});

test('spacing inside a line matters and is flagged as spacing-only', () => {
  const d = firstDifference('Hello  Python.\nBye', 'Hello Python.\nBye');
  assert.strictEqual(d.kind, 'differs');
  assert.strictEqual(d.line, 1);
  assert.strictEqual(d.index, 6); // first char after "Hello "
  assert.strictEqual(d.spacingOnly, true);
});

test('real value difference is not spacing-only', () => {
  const d = firstDifference('12', '13');
  assert.strictEqual(d.index, 1);
  assert.strictEqual(d.spacingOnly, false);
});

test('missing and extra lines', () => {
  assert.deepStrictEqual(firstDifference('a\nb', 'a'), { line: 2, kind: 'missing', expected: 'b' });
  assert.deepStrictEqual(firstDifference('a', 'a\nb'), { line: 2, kind: 'extra', actual: 'b' });
});

test('visible marks spaces, tabs and carriage returns', () => {
  assert.strictEqual(visible('a b\tc\r'), 'a·b→c␍');
});
