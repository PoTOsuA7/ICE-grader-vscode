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

  // -> [{id, code, name, hasTestcases}]
  async listProblems() {
    const html = await this._getText('main/list');
    const problems = [];
    for (const row of html.split(/<tr>/).slice(1)) {
      const name = /<strong>([\s\S]*?)<\/strong>/.exec(row);
      const code = /class='text-muted font-monospace'>([\s\S]*?)<\/div>/.exec(row);
      const stmt = /href="\/problems\/(\d+)\/download\/statement"/.exec(row);
      if (!name || !stmt) continue;
      problems.push({
        id: stmt[1],
        code: stripTags(code ? code[1] : name[1]),
        name: stripTags(name[1]),
        hasTestcases: /\/testcases\/show_problem\/\d+/.test(row),
      });
    }
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

module.exports = { GraderClient, decodeEntities };
