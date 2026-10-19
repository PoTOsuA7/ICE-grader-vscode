"""Explains why tests failed, using the student's own Gemini API key (from Google AI Studio). Nothing is sent
anywhere unless the student clicks Explain - never when tests run or on submit. A port of the VS Code
extension's lib/aiExplain.js: keep the two in step."""
import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .diff import compared_outputs, first_difference

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-3.8-flash"
FALLBACK_MODEL = "gemini-3.5-flash"
MAX_FAILURES = 3  # failing tests sent per request; usually they share one bug
MAX_FIELD = 2000  # characters per input/output, so a huge test can't blow up the request
RETRY_DELAYS = (2, 5)  # seconds, per model, for 500/503 "overloaded" answers

SYSTEM = """You are a patient teaching assistant helping a student debug their own coursework
solution. You will see their source code and the test cases it fails. Explain WHY it fails: the
likely bug, wrong assumption, or edge case missed, pointing at the specific lines involved. If
several tests fail for the same reason, say so once instead of repeating yourself.

Do not write any code: no corrected lines, no snippets, no rewritten program. The student must
fix it themselves. Refer to their code by line number or by quoting a short expression inline,
and describe the change in words. Keep the whole answer under ~250 words."""

CODE_REMOVED = "(Code removed: the explanation should help you find the fix, not write it.)"


class AIError(Exception):
    pass


def without_code(text):
    """The prompt asks for no code; this makes sure of it. Code blocks are removed; inline `names` stay."""
    text = re.sub(r"```[\s\S]*?(```|\Z)", CODE_REMOVED, text)  # also an unclosed block at the end
    text = re.sub("(" + re.escape(CODE_REMOVED) + r"\s*)+", CODE_REMOVED + "\n\n", text)
    return text.strip()


def _clip(s):
    return s[:MAX_FIELD] + "\n... (truncated)" if len(s) > MAX_FIELD else s


def describe_failure(f):
    """f: {n, input, expected?, partial_output?, actual, stderr?, verdict}"""
    lines = ["### Test %d - %s" % (f["n"], f["verdict"]), "Input:", "```", _clip(f.get("input") or "(empty)"), "```"]
    if f.get("expected") is not None:
        lines += ["Expected output:", "```", _clip(f["expected"]), "```"]
        # Same comparison as the runner: for a cut-off expected output only the visible part counts.
        cmp = compared_outputs({"output": f["expected"], "partial_output": f.get("partial_output")}, f.get("actual") or "")
        if f.get("partial_output"):
            lines.append("(Only the start of the expected output is known - the grader shows a 2 KB preview. Nothing after it was checked.)")
        d = None if cmp.get("unchecked") else first_difference(cmp["expected"], cmp["actual"])
        # Hand the model the difference already found, so it doesn't have to work it out and can't get it wrong.
        if d:
            where = "line %d, column %d" % (d["line"], d["index"] + 1) if d["kind"] == "differs" else "line %d (%s line)" % (d["line"], d["kind"])
            lines.append("(First difference from expected: %s)" % where)
    lines += ["Actual output:", "```", _clip(f.get("actual") or "(no output)"), "```"]
    if f.get("stderr"):
        lines += ["stderr:", "```", _clip(f["stderr"]), "```"]
    if f["verdict"] == "TLE":
        lines.append("(Did not finish within the time limit - suspect an infinite loop or a too-slow algorithm.)")
    return "\n".join(lines)


def build_prompt(code, failures, total_failing=None, problem=None, data_files=None, language="python"):
    shown = failures[:MAX_FAILURES]
    lines = []
    if problem:
        lines.append("Problem: %s%s" % (problem["code"], " - " + problem["name"] if problem.get("name") else ""))
    lines += ["Language: " + language, "", "Source code:", "```" + language, code, "```", ""]
    files = list((data_files or {}).items())[:5]
    if files:
        lines.append("Data files the program can open (at /data/<name> on the grader; the inputs below refer to them):")
        for name, text in files:
            lines += [name + ":", "```", _clip(text or "(empty)"), "```"]
        lines.append("")
    lines.append("Failing tests (%d of %d shown):" % (len(shown), total_failing or len(failures)))
    lines += [describe_failure(f) for f in shown]
    return "\n".join(lines)


def post(api_key, model, body, timeout=120):
    """-> (status, parsed JSON or None)"""
    url = "%s/%s:generateContent" % (API_BASE, urllib.parse.quote(model, safe=""))
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"x-goog-api-key": api_key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        with e:
            status, raw = e.code, e.read()
    except (socket.timeout, TimeoutError):
        raise AIError("Gemini took longer than 2 minutes to answer - try again.")
    except (urllib.error.URLError, OSError) as e:
        raise AIError("Could not reach the Gemini API: %s" % (getattr(e, "reason", None) or e))
    try:
        return status, json.loads(raw.decode("utf-8"))
    except ValueError:
        return status, None


def _busy(status):
    return status in (500, 503)


def _message(data):
    return ((data or {}).get("error") or {}).get("message") or ""


def _ask_model(api_key, model, body, retry_delays, send, sleep):
    """One model: retries while Google says it's overloaded. -> (status, data) of the last attempt"""
    attempt = 0
    while True:
        status, data = send(api_key, model, body)
        if status == 400 and re.search("thinking", _message(data), re.I) and body["generationConfig"].get("thinkingConfig"):
            # A model that doesn't take a thinking level: send the same request without it.
            body = dict(body, generationConfig={"maxOutputTokens": body["generationConfig"]["maxOutputTokens"]})
            continue
        if not _busy(status) or attempt >= len(retry_delays):
            return status, data
        sleep(retry_delays[attempt])
        attempt += 1


def call_gemini(api_key, models, prompt, retry_delays=RETRY_DELAYS, send=post, sleep=time.sleep):
    """models: the chosen model first, then fallbacks tried only while the earlier ones are overloaded.
    -> {text, model, fallback}: the model that answered, and whether a fallback had to answer"""
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        # Low thinking: explaining an already-diffed failure is easy, and full thinking can take over a minute.
        "generationConfig": {"maxOutputTokens": 4096, "thinkingConfig": {"thinkingLevel": "low"}},
    }
    tried = list(dict.fromkeys(m for m in models if m))
    if not tried:
        raise AIError("No Gemini model is set.")
    for model in tried:
        status, data = _ask_model(api_key, model, body, retry_delays, send, sleep)
        if not _busy(status):
            break
    msg = _message(data)
    if not 200 <= status < 300:
        if re.search("API key not valid|API_KEY_INVALID", msg, re.I) or status == 401:
            raise AIError("Invalid Gemini API key. Set it again with Grader > Set Gemini API key...")
        if status == 403:
            raise AIError("Gemini refused the request (403): %s" % (msg or "this key may not have API access"))
        if status == 404:
            raise AIError('Gemini model "%s" not found.' % model)
        if status == 429:
            raise AIError("Gemini's limit was reached (the free tier has daily limits) - try again later.")
        if _busy(status):
            raise AIError("Gemini is overloaded right now (tried %s). This is on Google's side - try again in a few minutes."
                          % ", ".join(tried))
        raise AIError(msg or "The Gemini request failed (%d)" % status)
    blocked = ((data or {}).get("promptFeedback") or {}).get("blockReason")
    if blocked:
        raise AIError("Gemini blocked the request (%s)." % blocked)
    candidates = (data or {}).get("candidates") or [{}]
    parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
    text = "".join(p["text"] for p in parts if isinstance(p.get("text"), str) and not p.get("thought")).strip()
    if not text:
        raise AIError("Gemini returned no explanation.")
    return {"text": without_code(text), "model": model, "fallback": model != tried[0]}
