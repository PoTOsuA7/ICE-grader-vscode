"""Talks to a Cafe Grader ("NatteeGrader") site. Standard library only, no Thonny imports, so it can be tested
on its own. A port of the VS Code extension's lib/client.js: keep the two in step."""
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "ZeroWidthSpace": "", "nbsp": " "}


def decode_entities(s):
    s = re.sub(r"&#x([0-9a-f]+);", lambda m: chr(int(m.group(1), 16)), s, flags=re.I)
    s = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    return re.sub(r"&([a-zA-Z]+);", lambda m: _ENTITIES.get(m.group(1), m.group(0)), s)


def _strip_tags(s):
    return decode_entities(re.sub(r"<[^>]*>", "", s)).strip()


# ---- page parsers (pure functions so they can be tested against saved HTML) ----

def parse_problem_list(html):
    """main/list -> [{id, code, name, has_testcases, status: 'solved'|'inprogress'|'untried', score,
    last_submission_id}]"""
    problems = []
    for row in html.split("<tr>")[1:]:
        name = re.search(r"<strong>([\s\S]*?)</strong>", row)
        code = re.search(r"class='text-muted font-monospace'>([\s\S]*?)</div>", row)
        stmt = re.search(r'href="/problems/(\d+)/download/statement"', row)
        if not name or not stmt:
            continue
        status = re.search(r"<td>\s*(solved|inprogress|untried)\s*</td>\s*</tr>", row, re.I)
        score = re.search(r"data-order='([\d.]+)'\s+style='width: 12em", row)
        sub = re.search(r'href="/submissions/(\d+)">\d+</a>', row)
        problems.append({
            "id": stmt.group(1),
            "code": _strip_tags(code.group(1) if code else name.group(1)),
            "name": _strip_tags(name.group(1)),
            "has_testcases": bool(re.search(r"/testcases/show_problem/\d+", row)),
            "status": status.group(1).lower() if status else "untried",
            "score": float(score.group(1)) if score else 0,
            "last_submission_id": sub.group(1) if sub else None,
        })
    return problems


def _field_after(html, label):
    """Text of the value cell that follows a label such as "Points" on a submission page."""
    m = re.search(r"\n" + re.escape(label) + r"\n</div>\s*<div class='col'>([\s\S]*?)</div>", html)
    return re.sub(r"\s+", " ", _strip_tags(m.group(1))) if m else ""


def parse_submission_page(html):
    """submissions/ID -> {points, max, status, readable, done, runtime, tests: [{n, total, label, letter}]}"""
    pts = re.search(r"([\d.]+)\s*/\s*([\d.]+)", _field_after(html, "Points"))
    status = _field_after(html, "Grading Task Status").lower()
    tests = [{"n": int(m.group(1)), "total": int(m.group(2)), "label": m.group(3), "letter": m.group(4)}
             for m in re.finditer(r'title="Test (\d+) of (\d+): ([^"]+)">([^<]*)<', html)]
    return {
        "points": float(pts.group(1)) if pts else None,
        "max": float(pts.group(2)) if pts else None,
        "status": status,
        # False when the page has no "Grading Task Status" row at all: not a submission page any more
        "readable": "\nGrading Task Status\n</div>" in html,
        "done": "done" in status,
        "runtime": _field_after(html, "Runtime"),
        "tests": tests,
    }


def parse_submission_source(html):
    """submissions/ID -> {source, language} (the code as it was submitted), or None if the page has no code"""
    m = re.search(r"<textarea[^>]*id=['\"]text_sourcecode['\"][^>]*>([\s\S]*?)</textarea>", html)
    if not m:
        return None
    # like a browser: a newline straight after <textarea> is not part of the text
    return {"source": re.sub(r"^\r?\n", "", decode_entities(m.group(1))), "language": _field_after(html, "Language")}


def parse_submit_form(html):
    """direct_edit_problem/ID -> {token, problem_id, languages: [{id, name}]}"""
    token = re.search(r'name="authenticity_token" value="([^"]+)"', html)
    pid = (re.search(r'name="submission\[problem_id\]"[^>]*value="(\d+)"', html)
           or re.search(r'value="(\d+)"[^>]*name="submission\[problem_id\]"', html))
    select = re.search(r'<select[^>]*id="language_id"[\s\S]*?</select>', html)
    languages = []
    if select:
        languages = [{"id": m.group(1), "name": decode_entities(m.group(2)).strip()}
                     for m in re.finditer(r'<option[^>]*value="(\d+)"[^>]*>([^<]*)</option>', select.group(0))]
    return {"token": decode_entities(token.group(1)) if token else None,
            "problem_id": pid.group(1) if pid else None, "languages": languages}


def is_login_page(html):
    """The login form is still on the page: the session expired, or a login was refused."""
    return bool(re.search(r"<input[^>]*name=[\"']password[\"']", html, re.I)
                or re.search(r"action=[\"'][^\"']*login/login[\"']", html, re.I))


def _looks_like_grader_page(html):
    return bool(re.search(r"main/list|logout", html, re.I))


def _flash_text(html):
    """Text of the page's alert/flash message, if it shows one."""
    m = re.search(r"<div[^>]*class=[\"'][^\"']*alert[^\"']*[\"'][^>]*>([\s\S]*?)</div>", html, re.I)
    return re.sub(r"\s+", " ", _strip_tags(m.group(1)))[:200] if m else ""


_UNITS = {"byte": 1, "bytes": 1, "kb": 1024, "mb": 1024 ** 2, "gb": 1024 ** 3}


def _to_bytes(num, unit):
    return float(num.replace(",", "")) * _UNITS[unit.lower()]


def _page_files(html, cap):
    """Each file on the test case page: an <h6> name, its real size, then a textarea showing it, capped
    (e.g. "Showing the first 2 KB of each file"). A file is "cut" when the size says there is more than shown.
    -> [{name, text, cut}]"""
    files = []
    for m in re.finditer(r"<h6[^>]*>([^<]*)</h6>[\s\S]*?<span class='text-secondary small'>([\d.,]+)\s*(Bytes?|KB|MB|GB)"
                         r"</span>[\s\S]*?<textarea[^>]*>([\s\S]*?)</textarea>", html, re.I):
        name, num, unit, raw = m.groups()
        text = decode_entities(raw)
        size = _to_bytes(num, unit)
        exact = bool(re.fullmatch(r"bytes?", unit, re.I))
        # Some templates put a newline right after <textarea> that isn't part of the file.
        if exact and text.startswith("\n") and len(text.encode("utf-8")) == size + 1:
            text = text[1:]
        shown = len(text.encode("utf-8"))
        cut = shown < size if exact else (size > shown * 1.05 or (shown >= cap - 8 and size >= cap))
        files.append({"name": decode_entities(name).strip(), "text": text, "cut": cut})
    return files


def _cap(html):
    m = re.search(r"Showing the first ([\d.,]+)\s*(Bytes?|KB|MB)", html, re.I)
    return _to_bytes(m.group(1), m.group(2)) if m else float("inf")


def parse_testcase_page(html):
    """testcases/show_problem/ID -> [{id, input, output, input_cut, output_cut}]"""
    cap = _cap(html)
    panes = re.split(r"<div class='tab-pane[^']*' id='tc(\d+)'", html.split("id='data-files'")[0])
    cases = []
    for i in range(1, len(panes) - 1, 2):
        files = _page_files(panes[i + 1], cap)
        if len(files) < 2:
            continue
        cases.append({"id": panes[i], "input": files[0]["text"], "output": files[1]["text"],
                      "input_cut": files[0]["cut"], "output_cut": files[1]["cut"]})
    return cases


def parse_data_files(html):
    """The "Data files read at run time" section: files the program opens (e.g. /data/data.txt)"""
    at = html.find("id='data-files'")
    return [] if at < 0 else _page_files(html[at:], _cap(html))


class GraderError(Exception):
    pass


class SessionExpired(GraderError):
    pass


class _Response:
    def __init__(self, status, headers, body, url):
        self.status, self.headers, self.body, self.url = status, headers, body, url

    @property
    def ok(self):
        return 200 <= self.status < 300

    def text(self):
        return self.body.decode("utf-8", "replace")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def _multipart(fields):
    boundary = "----icegrader" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, k, v)).encode("utf-8"))
    parts.append(("--%s--\r\n" % boundary).encode("ascii"))
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


class GraderClient:
    def __init__(self, root_url, cookies=None):
        self.root = root_url.rstrip("/") + "/"
        self.cookies = dict(cookies or {})

    def _request(self, url, data=None, content_type=None):
        """Keeps cookies across redirects and never waits forever. Like a browser, the grader's cookies (the session
        = account access) only go to the grader's own origin, and never over plain http."""
        home = urllib.parse.urlsplit(self.root)
        for _ in range(8):
            hop = urllib.parse.urlsplit(url)
            same_site = (hop.scheme, hop.netloc) == (home.scheme, home.netloc)
            headers = {"User-Agent": "thonny-ice-grader"}
            if content_type:
                headers["Content-Type"] = content_type
            if same_site and self.cookies:
                headers["Cookie"] = "; ".join("%s=%s" % kv for kv in self.cookies.items())
            req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
            try:
                with _opener.open(req, timeout=30) as r:
                    status, hdrs, body = r.status, r.headers, r.read()
            except urllib.error.HTTPError as e:  # 3xx (redirects are followed here) and 4xx/5xx
                with e:
                    status, hdrs, body = e.code, e.headers, e.read()
            if same_site:
                for line in hdrs.get_all("Set-Cookie") or []:
                    pair = line.split(";")[0]
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        self.cookies[k.strip()] = v.strip()
            loc = hdrs.get("Location")
            if 300 <= status < 400 and loc:
                url = urllib.parse.urljoin(url, loc)
                data, content_type = None, None  # follow redirects as GET
                continue
            return _Response(status, hdrs, body, url)
        raise GraderError("Too many redirects")

    def _get_text(self, path):
        r = self._request(urllib.parse.urljoin(self.root, path))
        if not r.ok:
            raise GraderError("GET %s failed (%d)" % (path, r.status))
        return r.text()

    def login(self, uid, password):
        self.cookies.clear()
        index = self._get_text("")
        m = (re.search(r'name="authenticity_token"[^>]*value="([^"]+)"', index)
             or re.search(r'value="([^"]+)"[^>]*name="authenticity_token"', index))
        if not m:
            raise GraderError("No login form found at %s - is the address right?" % self.root)
        body = urllib.parse.urlencode({"utf8": "✓", "authenticity_token": decode_entities(m.group(1)),
                                       "login": uid, "password": password, "commit": "login"}).encode("utf-8")
        r = self._request(self.root + "login/login", body, "application/x-www-form-urlencoded")
        text = r.text()
        if not r.ok:
            raise GraderError("Sign-in failed (%d)" % r.status)
        if "Wrong password" in text:
            raise GraderError("Wrong ID or password")
        if is_login_page(text):
            flash = _flash_text(text)
            raise GraderError("Sign-in refused" + (": " + flash if flash else " - the grader sent you back to the sign-in page"))

    def list_problems(self):
        html = self._get_text("main/list")
        problems = parse_problem_list(html)
        if not problems:
            if is_login_page(html):
                raise SessionExpired("Your grader session has expired - sign in again.")
            raise GraderError("No problems found - the grader's page may have changed")
        return problems

    def fetch_statement(self, problem_id):
        """-> (bytes, extension)"""
        r = self._request(urllib.parse.urljoin(self.root, "problems/%s/download/statement" % problem_id))
        if not r.ok:
            raise GraderError("Statement download failed (%d)" % r.status)
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        if ctype == "text/html":
            body = r.text()
            if is_login_page(body):
                raise SessionExpired("Your grader session has expired - sign in again.")
            if _looks_like_grader_page(body):
                flash = _flash_text(body)
                raise GraderError("The grader did not return a statement for this problem" + (" (%s)" % flash if flash else ""))
            return r.body, ".html"
        fn = re.search(r'filename="?([^";]+)"?', r.headers.get("Content-Disposition") or "")
        ext = re.search(r"\.[A-Za-z0-9]+$", fn.group(1)) if fn else None
        ext = ext.group(0) if ext else {"application/pdf": ".pdf", "text/plain": ".txt"}.get(ctype, ".bin")
        return r.body, ext.lower()

    def fetch_testcases(self, problem_id):
        """-> [{input, output, partial_input?, partial_output?, files?}]. Read from the test case page only: the
        instructors turned test downloads off, so a file cut off there is kept as the visible part and flagged
        partial. `files` are the problem's data files ({name: text}), which the program may open while it runs."""
        html = self._get_text("testcases/show_problem/%s" % problem_id)
        page = parse_testcase_page(html)
        if not page:
            if is_login_page(html):
                raise SessionExpired("Your grader session has expired - sign in again.")
            raise GraderError("No test cases visible for this problem")
        data = parse_data_files(html)
        files = {f["name"]: f["text"] for f in data} or None
        data_cut = any(f["cut"] for f in data)  # a cut data file makes every run unreliable
        cases = []
        for tc in page:
            c = {"input": tc["input"], "output": tc["output"]}
            if tc["input_cut"] or data_cut:
                c["partial_input"] = True
            if tc["output_cut"]:
                c["partial_output"] = True
            if files:
                c["files"] = files
            cases.append(c)
        return cases

    def _last_submission(self, problem_id):
        mine = [p for p in parse_problem_list(self._get_text("main/list")) if p["id"] == str(problem_id)]
        return int(mine[0]["last_submission_id"]) if mine and mine[0]["last_submission_id"] else 0

    def submit(self, problem_id, source):
        """Submits Python code. -> {id, language}"""
        # The previous submission's id, so a refused submit can't be mistaken for an old one.
        previous = self._last_submission(problem_id)
        form = parse_submit_form(self._get_text("submissions/direct_edit_problem/%s" % problem_id))
        if not form["token"] or not form["problem_id"]:
            raise GraderError("Could not read the submit form (session expired or the page changed)")
        lang = next((l for l in form["languages"] if re.search("python", l["name"], re.I)), None)
        if not lang:
            avail = ", ".join(l["name"] for l in form["languages"]) or "none"
            raise GraderError("This problem doesn't accept Python (available languages: %s)" % avail)
        body, ctype = _multipart({"authenticity_token": form["token"], "editor_text": source,
                                  "submission[problem_id]": form["problem_id"], "language_id": lang["id"],
                                  "commit": "Submit"})
        r = self._request(self.root + "main/submit", body, ctype)
        if not r.ok:
            raise GraderError("Submit failed (%d)" % r.status)
        # The grader redirects to the new submission. Otherwise use the problem's newest submission, but only if it
        # is newer than before: a refused submit (too long, problem closed, ...) re-renders the page.
        m = re.search(r"/submissions/(\d+)", r.url)
        sid = m.group(1) if m else None
        if not sid:
            newest = self._last_submission(problem_id)
            if newest > previous:
                sid = str(newest)
        if not sid:
            flash = _flash_text(r.text())
            raise GraderError("The grader did not accept the submission" + (": " + flash if flash else "."))
        return {"id": sid, "language": lang["name"]}

    def wait_for_grade(self, submission_id, timeout=90, interval=1.5, on_update=None):
        """Polls a submission until grading finishes (or the timeout passes). -> parse_submission_page() + timed_out"""
        start = time.time()
        while True:
            html = self._get_text("submissions/%s" % submission_id)
            r = parse_submission_page(html)
            if not r["readable"]:
                if is_login_page(html):
                    raise SessionExpired("Session expired while waiting for submission #%s - check it on the grader site." % submission_id)
                raise GraderError("Could not read the grading status of submission #%s - check it on the grader site." % submission_id)
            if on_update:
                on_update(r)
            if r["done"] or time.time() - start > timeout:
                r["timed_out"] = not r["done"]
                return r
            time.sleep(interval)

    def fetch_submission_source(self, submission_id):
        """Your code for a submission, as you submitted it. -> {source, language}"""
        html = self._get_text("submissions/%s" % submission_id)
        r = parse_submission_source(html)
        if r:
            return r
        if is_login_page(html):
            raise SessionExpired("Your grader session has expired - sign in again.")
        raise GraderError("Could not read the code of submission #%s (the grader's page has changed)" % submission_id)


