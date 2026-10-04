'use strict';
// Explains why tests failed, using the student's own Gemini API key (from Google AI Studio).
// Calls the REST endpoint with plain fetch, like lib/client.js does for the grader, so the
// extension still needs no npm packages. Nothing is sent anywhere unless the user runs the
// command - never as part of run-on-save or submit.
const { firstDifference } = require('./diff');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_FAILURES = 3; // failing tests sent per request; usually they share one bug
const MAX_FIELD = 2000; // characters per input/output, so a huge test can't blow up the request

const SYSTEM = `You are a patient teaching assistant helping a student debug their own coursework
solution. You will see their source code and the test cases it fails. Explain WHY it fails: the
likely bug, wrong assumption, or edge case missed, pointing at the specific lines involved. If
several tests fail for the same reason, say so once instead of repeating yourself.

Do not rewrite the program and do not give a corrected or complete version of the code - the
student must fix it themselves. A short illustrative snippet (a couple of lines, not a drop-in
replacement) is fine if it helps explain a concept. Keep the whole answer under ~250 words.`;

const clip = (s) => (s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '\n... (truncated)' : s);

// failure: { n, testInput, expected?, actual, stderr?, verdict }
function describeFailure({ n, testInput, expected, actual, stderr, verdict }) {
  const lines = [`### Test ${n} - ${verdict}`, 'Input:', '```', clip(testInput || '(empty)'), '```'];
  if (expected !== undefined) {
    lines.push('Expected output:', '```', clip(expected), '```');
    const d = firstDifference(expected, actual || '');
    // Hand the model the diff we already computed, so it doesn't have to re-derive it and can't get it wrong.
    if (d) lines.push(`(First difference from expected: ${d.kind === 'differs' ? `line ${d.line}, column ${d.index + 1}` : `line ${d.line} (${d.kind} line)`})`);
  }
  lines.push('Actual output:', '```', clip(actual || '(no output)'), '```');
  if (stderr) lines.push('stderr:', '```', clip(stderr), '```');
  if (verdict === 'TLE') lines.push('(Did not finish within the time limit - suspect an infinite loop or a too-slow algorithm.)');
  return lines.join('\n');
}

// context: { code, language, problem?, failures: [...], totalFailing, dataFiles?: {name: text} }
function buildPrompt({ code, language, problem, failures, totalFailing, dataFiles }) {
  const shown = failures.slice(0, MAX_FAILURES);
  const files = Object.entries(dataFiles || {}).slice(0, 5);
  const lines = [
    problem ? `Problem: ${problem.code}${problem.name ? ' - ' + problem.name : ''}` : null,
    `Language: ${language}`,
    '',
    'Source code:', '```' + language, code, '```',
    '',
    ...(files.length ? [
      'Data files the program can open (at /data/<name> on the grader; the inputs below refer to them):',
      ...files.flatMap(([name, text]) => [`${name}:`, '```', clip(text || '(empty)'), '```']),
      '',
    ] : []),
    `Failing tests (${shown.length} of ${totalFailing || failures.length} shown):`,
    ...shown.map(describeFailure),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function post(apiKey, model, body) {
  try {
    return await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('Gemini took longer than 2 minutes to answer - try again, or pick a faster model in nattee.geminiModel.');
    throw new Error(`Could not reach the Gemini API: ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [2000, 5000]; // per model, for 500/503 "overloaded" answers
const isBusy = (status) => status === 500 || status === 503;

// One model: retries while Google says it's overloaded. -> { res, data } of the last attempt
async function askModel(apiKey, model, body, retryDelays) {
  let res, data;
  for (let attempt = 0; ; attempt++) {
    res = await post(apiKey, model, body);
    data = await res.json().catch(() => null);
    const msg = (data && data.error && data.error.message) || '';
    if (res.status === 400 && /thinking/i.test(msg) && body.generationConfig.thinkingConfig) {
      // A model that doesn't take a thinking level: send the same request without it.
      body = { ...body, generationConfig: { maxOutputTokens: body.generationConfig.maxOutputTokens } };
      attempt--;
      continue;
    }
    if (!isBusy(res.status) || attempt >= retryDelays.length) return { res, data };
    await sleep(retryDelays[attempt]);
  }
}

// models: the chosen model first, then fallbacks tried only while the earlier ones are overloaded.
async function callGemini(apiKey, models, prompt, { retryDelays = RETRY_DELAYS_MS } = {}) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Low thinking: explaining an already-diffed failure is easy, and full thinking can take
    // over a minute before anything comes back.
    generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } },
  };
  const tried = [...new Set(models.filter(Boolean))];
  let res, data, model;
  for (model of tried) {
    ({ res, data } = await askModel(apiKey, model, body, retryDelays));
    if (!isBusy(res.status)) break;
  }
  const apiMessage = (data && data.error && data.error.message) || '';
  if (!res.ok) {
    if (/API key not valid|API_KEY_INVALID/i.test(apiMessage) || res.status === 401) {
      throw new Error('Invalid Gemini API key. Run "Nattee: Set Gemini API Key" to update it.');
    }
    if (res.status === 403) throw new Error(`Gemini refused the request (403): ${apiMessage || 'this key may not have API access'}`);
    if (res.status === 404) throw new Error(`Gemini model "${model}" not found. Check the nattee.geminiModel setting.`);
    if (res.status === 429) throw new Error('Gemini API quota or rate limit reached (the free tier has daily limits) - try again later.');
    if (isBusy(res.status)) {
      throw new Error(`Gemini is overloaded right now (${res.status}; tried ${tried.join(', ')}, each ${1 + retryDelays.length} times). This is on Google's side - try again in a few minutes.`);
    }
    if (res.status >= 500) throw new Error(`Gemini API server error (${res.status}) - try again.`);
    throw new Error(apiMessage || `Gemini API request failed (${res.status})`);
  }
  const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
  if (blocked) throw new Error(`Gemini blocked the request (${blocked}).`);
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  if (!text) throw new Error('Gemini returned no explanation.');
  return { text, model };
}

// -> { text, model } where model is the one that actually answered
async function explainFailures(apiKey, models, context, opts) {
  return callGemini(apiKey, Array.isArray(models) ? models : [models], buildPrompt(context), opts);
}

module.exports = { explainFailures, buildPrompt, MAX_FAILURES };
