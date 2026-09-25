'use strict';
// Talks to a Cafe Grader ("NatteeGrader") site. Pure Node (global fetch), no VS Code deps,
// so it can also be exercised from a plain script.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ZeroWidthSpace: '', nbsp: ' ' };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, '')).trim();

// ---- page parsers (pure functions so they can be tested against saved HTML) ----

// main/list -> [{id, code, name, hasTestcases, status: 'solved'|'inprogress'|'untried', score, lastSubmissionId}]
function parseProblemList(html) {
  const problems = [];
  for (const row of html.split(/<tr>/).slice(1)) {
    const name = /<strong>([\s\S]*?)<\/strong>/.exec(row);
    const code = /class='text-muted font-monospace'>([\s\S]*?)<\/div>/.exec(row);
    const stmt = /href="\/problems\/(\d+)\/download\/statement"/.exec(row);
    if (!name || !stmt) continue;
    const status = /<td>\s*(solved|inprogress|untried)\s*<\/td>\s*<\/tr>/i.exec(row);
    const score = /data-order='([\d.]+)'\s+style='width: 12em/.exec(row);
    const sub = /href="\/submissions\/(\d+)">\d+<\/a>/.exec(row);
    problems.push({
      id: stmt[1],
      code: stripTags(code ? code[1] : name[1]),
      name: stripTags(name[1]),
      hasTestcases: /\/testcases\/show_problem\/\d+/.test(row),
      status: status ? status[1].toLowerCase() : 'untried',
      score: score ? parseFloat(score[1]) : 0,
      lastSubmissionId: sub ? sub[1] : null,
    });
  }
  return problems;
}

// text of the value cell that follows a label such as "Points" on a submission page
function fieldAfter(html, label) {
  const m = new RegExp(String.raw`\n${label}\n</div>\s*<div class='col'>([\s\S]*?)</div>`).exec(html);
  return m ? stripTags(m[1]).replace(/\s+/g, ' ') : '';
}

// submissions/ID -> { points, max, status, done, runtime, tests: [{n, total, label, letter}] }
function parseSubmissionPage(html) {
  const pts = /([\d.]+)\s*\/\s*([\d.]+)/.exec(fieldAfter(html, 'Points'));
  const status = fieldAfter(html, 'Grading Task Status').toLowerCase();
  const tests = [...html.matchAll(/title="Test (\d+) of (\d+): ([^"]+)">([^<]*)</g)]
    .map((m) => ({ n: +m[1], total: +m[2], label: m[3], letter: m[4] }));
  return {
    points: pts ? parseFloat(pts[1]) : null,
    max: pts ? parseFloat(pts[2]) : null,
    status,
    done: /done/.test(status),
    runtime: fieldAfter(html, 'Runtime'),
    tests,
  };
}

// direct_edit_problem/ID -> { token, problemId, languages: [{id, name}] }
function parseSubmitForm(html) {
  const token = /name="authenticity_token" value="([^"]+)"/.exec(html);
  const pid = /name="submission\[problem_id\]"[^>]*value="(\d+)"/.exec(html) ||
    /value="(\d+)"[^>]*name="submission\[problem_id\]"/.exec(html);
  const select = /<select[^>]*id="language_id"[\s\S]*?<\/select>/.exec(html);
  const languages = select
    ? [...select[0].matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({ id: m[1], name: decodeEntities(m[2]).trim() }))
    : [];
  return { token: token ? decodeEntities(token[1]) : null, problemId: pid ? pid[1] : null, languages };
}

const LANGUAGE_PATTERNS = { '.py': /python/i, '.cpp': /c\+\+|cpp/i, '.c': /^c$|^c\s|ansi c/i };

class GraderClient {
  constructor(rootUrl) {
    this.root = rootUrl.replace(/\/+$/, '') + '/';
    this.cookies = new Map();
  }

  _absorbCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  // fetch that keeps cookies across redirects and never waits forever.
  async _request(url, opts = {}) {
    for (let hops = 0; hops < 8; hops++) {
      const headers = { ...(opts.headers || {}) };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, { ...opts, headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      this._absorbCookies(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).href;
        opts = { headers: opts.headers }; // follow redirects as GET
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  }

  async _getText(path) {
    const res = await this._request(new URL(path, this.root).href);
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
    return res.text();
  }

  async login(uid, password) {
    this.cookies.clear();
    const index = await this._getText('');
    const m = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(index) ||
      /value="([^"]+)"[^>]*name="authenticity_token"/.exec(index);
    if (!m) throw new Error(`No login form found at ${this.root} - is the server URL correct?`);
    const body = new URLSearchParams({
      utf8: '✓', authenticity_token: decodeEntities(m[1]), login: uid, password, commit: 'login',
    });
    const res = await this._request(this.root + 'login/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Login failed (${res.status})`);
    if (text.includes('Wrong password')) throw new Error('Wrong username or password');
  }

  async listProblems() {
    const problems = parseProblemList(await this._getText('main/list'));
    if (!problems.length) throw new Error('No problems found - session expired or page layout changed');
    return problems;
  }

  // -> Buffer + extension
  async fetchStatement(problemId) {
    const res = await this._request(new URL(`problems/${problemId}/download/statement`, this.root).href);
    if (!res.ok) throw new Error(`Statement download failed (${res.status})`);
    const disp = res.headers.get('content-disposition') || '';
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (type === 'text/html') {
      const body = await res.text();
      if (body.includes('authenticity_token')) throw new Error('Session expired while downloading the statement');
      return { data: Buffer.from(body), ext: '.html' };
    }
    const fn = /filename="?([^";]+)"?/.exec(disp);
    const ext = (fn && /\.[A-Za-z0-9]+$/.exec(fn[1])?.[0]) ||
      { 'application/pdf': '.pdf', 'text/html': '.html', 'text/plain': '.txt' }[type] || '.bin';
    return { data: Buffer.from(await res.arrayBuffer()), ext: ext.toLowerCase() };
  }

  // -> [{input, output}] exactly as the grader stores them
  async fetchTestcases(problemId) {
    const html = await this._getText(`testcases/show_problem/${problemId}`);
    const ids = [...html.matchAll(/id='tc(\d+)'/g)].map((m) => m[1]);
    if (!ids.length) throw new Error('No test cases visible for this problem (not published, or session expired)');
    const cases = [];
    for (const id of ids) {
      const [input, output] = await Promise.all(['download_input', 'download_sol'].map(async (kind) => {
        const res = await this._request(new URL(`testcases/${id}/${kind}`, this.root).href);
        if (!res.ok) throw new Error(`Test case ${id} ${kind} failed (${res.status})`);
        return res.text();
      }));
      cases.push({ input, output });
    }
    return cases;
  }
}

GraderClient.prototype.submit = async function submit(problemId, source, ext) {
  const form = parseSubmitForm(await this._getText(`submissions/direct_edit_problem/${problemId}`));
  if (!form.token || !form.problemId) throw new Error('Could not read the submit form (session expired or the page layout changed)');
  const pattern = LANGUAGE_PATTERNS[ext.toLowerCase()];
  const lang = pattern && form.languages.find((l) => pattern.test(l.name));
  if (!lang) {
    const avail = form.languages.map((l) => l.name).join(', ') || 'none';
    throw new Error(`This problem doesn't accept ${ext} files (available languages: ${avail})`);
  }
  const body = new FormData();
  body.set('authenticity_token', form.token);
  body.set('editor_text', source);
  body.set('submission[problem_id]', form.problemId);
  body.set('language_id', lang.id);
  body.set('commit', 'Submit');
  const res = await this._request(this.root + 'main/submit', { method: 'POST', body });
  if (!res.ok) throw new Error(`Submit failed (${res.status})`);
  const html = await res.text();
  // the grader redirects to the new submission; otherwise fall back to the newest one in the list
  let id = /\/submissions\/(\d+)/.exec(res.url) ? /\/submissions\/(\d+)/.exec(res.url)[1] : null;
  if (!id) {
    const mine = parseProblemList(await this._getText('main/list')).find((p) => p.id === String(problemId));
    id = mine && mine.lastSubmissionId;
  }
  if (!id) throw new Error(`Submitted, but could not find the submission id. ${/error|invalid/i.test(html) ? 'The grader reported an error.' : ''}`);
  return { id, language: lang.name };
};

// Polls a submission until grading finishes (or the timeout passes). -> parseSubmissionPage() result + { timedOut }
GraderClient.prototype.waitForGrade = async function waitForGrade(submissionId, { timeoutMs = 90000, intervalMs = 1500, onUpdate } = {}) {
  const start = Date.now();
  for (;;) {
    const r = parseSubmissionPage(await this._getText(`submissions/${submissionId}`));
    if (onUpdate) onUpdate(r);
    if (r.done) return { ...r, timedOut: false };
    if (Date.now() - start > timeoutMs) return { ...r, timedOut: true };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
};

module.exports = { GraderClient, decodeEntities, parseProblemList, parseSubmissionPage, parseSubmitForm };
