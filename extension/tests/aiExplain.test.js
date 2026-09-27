'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { explainFailures, buildPrompt, MAX_FAILURES } = require('../lib/aiExplain');

const fail = (n, extra = {}) => ({ n, testInput: `${n} ${n}\n`, expected: `${n * 2}\n`, actual: `${n}\n`, verdict: 'FAIL', ...extra });

test('buildPrompt includes code, every failing test and the computed first difference', () => {
  const prompt = buildPrompt({
    code: 'print(1+1)', language: 'py', problem: { code: '01_Expr_01', name: 'Sum' },
    failures: [fail(2), fail(5)], totalFailing: 2,
  });
  assert.match(prompt, /01_Expr_01 - Sum/);
  assert.match(prompt, /print\(1\+1\)/);
  assert.match(prompt, /### Test 2 - FAIL/);
  assert.match(prompt, /### Test 5 - FAIL/);
  assert.match(prompt, /First difference from expected: line 1, column 1/);
  assert.match(prompt, /2 of 2 shown/);
});

test('buildPrompt caps how many tests and how much text it sends', () => {
  const many = Array.from({ length: 8 }, (_, i) => fail(i + 1, { testInput: 'x'.repeat(5000) }));
  const prompt = buildPrompt({ code: 'x', language: 'py', failures: many, totalFailing: 8 });
  assert.strictEqual((prompt.match(/### Test/g) || []).length, MAX_FAILURES);
  assert.match(prompt, new RegExp(`${MAX_FAILURES} of 8 shown`));
  assert.match(prompt, /\(truncated\)/);
  assert.ok(prompt.length < 5000 * MAX_FAILURES);
});

test('buildPrompt notes a timeout instead of diffing output', () => {
  const prompt = buildPrompt({ code: 'while True: pass', language: 'py', failures: [{ n: 1, testInput: '1\n', actual: '', verdict: 'TLE' }] });
  assert.match(prompt, /Did not finish within the time limit/);
  assert.doesNotMatch(prompt, /Expected output/);
});

// Fake Gemini endpoint: checks what we send, answers from a list of canned replies. Never touches the network.
function fakeGemini(...replies) {
  const realFetch = globalThis.fetch;
  const sent = [];
  const models = [];
  globalThis.fetch = async (url, opts) => {
    const m = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent$/.exec(url);
    assert.ok(m, `unexpected URL ${url}`);
    assert.strictEqual(opts.headers['x-goog-api-key'], 'test-key');
    models.push(m[1]);
    sent.push(JSON.parse(opts.body));
    const [status, body] = replies[Math.min(sent.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status });
  };
  return { sent, models, restore: () => { globalThis.fetch = realFetch; } };
}

const ctx = { code: 'print(1+1)', language: 'py', failures: [fail(1)], totalFailing: 1 };
const NO_WAIT = { retryDelays: [0, 0] };
const run = (models = 'gemini-3.8-flash') => explainFailures('test-key', models, ctx, NO_WAIT);
const ok = (text) => [200, { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text }] } }] }];

test('sends the prompt with low thinking and returns the text, skipping thought parts', async () => {
  const f = fakeGemini(ok('You printed the wrong thing.'));
  try {
    assert.deepStrictEqual(await run(), { text: 'You printed the wrong thing.', model: 'gemini-3.8-flash' });
    assert.ok(f.sent[0].contents[0].parts[0].text.includes('print(1+1)'));
    assert.ok(f.sent[0].systemInstruction.parts[0].text.includes('Do not rewrite the program'));
    assert.strictEqual(f.sent[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
  } finally { f.restore(); }
});

test('retries without the thinking setting if the model rejects it', async () => {
  const f = fakeGemini([400, { error: { message: 'Invalid JSON payload received. Unknown name "thinkingLevel" at generation_config.thinking_config' } }], ok('fine'));
  try {
    assert.strictEqual((await run()).text, 'fine');
    assert.strictEqual(f.sent.length, 2);
    assert.strictEqual(f.sent[1].generationConfig.thinkingConfig, undefined);
  } finally { f.restore(); }
});

test('a bad API key gives a clear message', async () => {
  const f = fakeGemini([400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
  try { await assert.rejects(() => run(), /Invalid Gemini API key/); } finally { f.restore(); }
});

test('a used-up free-tier quota is explained', async () => {
  const f = fakeGemini([429, { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }]);
  try { await assert.rejects(() => run(), /quota or rate limit/); } finally { f.restore(); }
});

test('a blocked prompt is reported instead of an empty answer', async () => {
  const f = fakeGemini([200, { promptFeedback: { blockReason: 'SAFETY' } }]);
  try { await assert.rejects(() => run(), /blocked the request \(SAFETY\)/); } finally { f.restore(); }
});

test('a timeout says Gemini was slow, not that it was unreachable', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  try { await assert.rejects(() => run(), /longer than 2 minutes/); } finally { globalThis.fetch = realFetch; }
});

const busy = [503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }];

test('an overloaded model is retried before giving up', async () => {
  const f = fakeGemini(busy, busy, ok('second retry worked'));
  try {
    assert.deepStrictEqual(await run(), { text: 'second retry worked', model: 'gemini-3.8-flash' });
    assert.deepStrictEqual(f.models, ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash']);
  } finally { f.restore(); }
});

test('if the main model stays overloaded, the fallback model answers', async () => {
  const f = fakeGemini(busy, busy, busy, ok('from fallback'));
  try {
    assert.deepStrictEqual(await run(['gemini-3.8-flash', 'gemini-3.5-flash']), { text: 'from fallback', model: 'gemini-3.5-flash' });
    assert.deepStrictEqual(f.models, ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash']);
  } finally { f.restore(); }
});

test('when every model is overloaded, the message says it is on Google\'s side', async () => {
  const f = fakeGemini(busy);
  try {
    await assert.rejects(() => run(['gemini-3.8-flash', 'gemini-3.5-flash']), /overloaded right now \(503; tried gemini-3\.8-flash, gemini-3\.5-flash, each 3 times\)/);
    assert.strictEqual(f.models.length, 6);
  } finally { f.restore(); }
});

test('a bad key is not retried or sent to the fallback model', async () => {
  const f = fakeGemini([400, { error: { message: 'API key not valid. Please pass a valid API key.' } }]);
  try {
    await assert.rejects(() => run(['gemini-3.8-flash', 'gemini-3.5-flash']), /Invalid Gemini API key/);
    assert.strictEqual(f.models.length, 1);
  } finally { f.restore(); }
});
