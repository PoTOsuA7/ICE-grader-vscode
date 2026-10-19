"""Runs a Python solution against grader test cases. A port of the VS Code extension's lib/runner.js."""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from .diff import compared_outputs, normalize

MAX_OUTPUT = 1 << 20  # stop collecting after 1 MiB so an infinite printer can't eat memory
DEFAULT_TIME_LIMIT = 3.0
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # Thonny itself has no console: don't flash one up


def _remove_dir(d):
    # On Windows a process that is still running (one the solution left behind) can keep it locked.
    shutil.rmtree(d, ignore_errors=True)


def kill_tree(proc):
    """Kill the process and everything it started."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    else:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            try:
                proc.kill()
            except OSError:
                pass


def data_sandbox(files):
    """Data files: on the grader a problem's data files sit in /data/ and the test input names them by that
    absolute path (e.g. "/data/data.txt 2562"). Locally they're written to a temp folder, the program runs there,
    and "/data/<name>" in the input becomes the relative "data/<name>". The files are also put in the working
    directory under their bare name. -> folder or None"""
    if not files:
        return None
    d = tempfile.mkdtemp(prefix="ice-grader-data-")
    try:
        os.mkdir(os.path.join(d, "data"))
        for name, text in files.items():
            safe = os.path.basename(name.replace("\\", "/"))  # never write outside the sandbox
            if not safe or safe in (".", ".."):
                continue
            for target in [os.path.join(d, "data", safe)] + ([os.path.join(d, safe)] if safe != "data" else []):
                with open(target, "w", encoding="utf-8", newline="") as f:
                    f.write(text)
    except Exception:
        _remove_dir(d)
        raise
    return d


def map_data_paths(text, files):
    for name in files or {}:
        text = text.replace("/data/" + name, "data/" + os.path.basename(name.replace("\\", "/")))
    return text


def _reader(stream, sink):
    size = 0
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        if size < MAX_OUTPUT:
            sink.append(chunk)
            size += len(chunk)


def run_one(python, file, text, time_limit, cwd=None):
    """-> {stdout, stderr, code, timed_out, ms}"""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    start = time.time()
    proc = subprocess.Popen([python, file], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            cwd=cwd, env=env, creationflags=_NO_WINDOW, start_new_session=sys.platform != "win32")
    out, err = [], []
    readers = [threading.Thread(target=_reader, args=(proc.stdout, out), daemon=True),
               threading.Thread(target=_reader, args=(proc.stderr, err), daemon=True)]
    for t in readers:
        t.start()

    def feed():  # in a thread: a program that never reads its input must not block us before the time limit
        try:
            proc.stdin.write(text.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass  # the program exited without reading all its input

    threading.Thread(target=feed, daemon=True).start()
    timed_out = False
    try:
        proc.wait(timeout=time_limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc)
        proc.wait()
    ms = int((time.time() - start) * 1000)
    for t in readers:
        t.join(1.5)  # don't hang if a leftover child keeps the pipes open
    if any(t.is_alive() for t in readers):
        kill_tree(proc)
    for pipe in (proc.stdout, proc.stderr):
        try:
            pipe.close()
        except OSError:
            pass
    decode = lambda parts: b"".join(parts).decode("utf-8", "replace").replace("\r\n", "\n")
    return {"stdout": decode(out), "stderr": decode(err), "code": proc.returncode, "timed_out": timed_out, "ms": ms}


def run_tests(python, file, cases, time_limit=DEFAULT_TIME_LIMIT, on_result=None):
    """-> [{verdict: 'PASS'|'FAIL'|'TLE'|'RE'|'SKIP', ms, stdout, stderr, skipped?}]
    SKIP: the grader only shows the start of this test's input (skipped: 'input'), so it can't be run here,
    or so little of the expected output that there is nothing to compare (skipped: 'output')."""
    if not time_limit or time_limit <= 0:
        time_limit = DEFAULT_TIME_LIMIT
    results = []
    for i, tc in enumerate(cases):
        if tc.get("partial_input"):
            r = {"verdict": "SKIP", "skipped": "input", "ms": 0, "stdout": "", "stderr": ""}
        else:
            box = data_sandbox(tc.get("files"))
            try:
                run = run_one(python, file, map_data_paths(tc["input"], tc.get("files")), time_limit, box)
            finally:
                if box:
                    _remove_dir(box)
            cmp = compared_outputs(tc, run["stdout"])
            if run["timed_out"]:
                verdict = "TLE"
            elif run["code"] != 0:
                verdict = "RE"
            elif cmp.get("unchecked"):
                verdict = "SKIP"
            elif normalize(cmp["actual"]) != normalize(cmp["expected"]):
                verdict = "FAIL"
            else:
                verdict = "PASS"
            r = {"verdict": verdict, "ms": run["ms"], "stdout": run["stdout"], "stderr": run["stderr"]}
            if verdict == "SKIP":
                r["skipped"] = "output"
        results.append(r)
        if on_result:
            on_result(i, r)
    return results
