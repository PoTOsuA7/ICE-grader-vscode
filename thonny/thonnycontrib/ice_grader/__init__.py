"""ICE Nattee Grader for Thonny: the NatteeGrader website inside Thonny. A "Grader" panel lists your problems with
your progress, opens statements and solution files, runs the grader's tests on your code and submits it."""
import datetime
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from tkinter import font as tkfont

from .client import GraderError, SessionExpired
from .core import DEFAULT_ROOT, Core, NotSignedIn
from .diff import compared_outputs, first_difference, visible
from .layout import chapter_of, safe_name, solution_path

logger = logging.getLogger(__name__)

MENU = "Grader"
EXPORT_PREFIX = "ice-grader-export-"
COLORS = {"PASS": "#2ea043", "FAIL": "#e5534b", "RE": "#e5534b", "TLE": "#d29922", "SKIP": "#8b949e"}

_core = None
_tasks = queue.Queue()
_busy = set()  # what is running now: "tests", "submit", "download"


def _wb():
    from thonny import get_workbench
    return get_workbench()


def core():
    global _core
    if _core is None:
        from thonny import THONNY_USER_DIR
        _core = Core(os.path.join(THONNY_USER_DIR, "ice_grader"), _wb().get_option("ice_grader.root_url") or DEFAULT_ROOT)
    return _core


# ---------------------------------------------------------------- background work
# Network and test runs happen in a thread; what they report is handed back to Tk's thread through a queue.

def later(fn, *args):
    """Run fn(*args) on Tk's thread (from any thread)."""
    _tasks.put(lambda: fn(*args))


def in_background(work, done=None, what=None, failed=None):
    """work() in a thread, then done(result) or failed(error) (default: an error box) on Tk's thread. With `what`,
    a second call while the first is still running is ignored."""
    if what:
        if what in _busy:
            return
        _busy.add(what)

    def run():
        try:
            result = work()
        except Exception as e:  # noqa: BLE001 - shown to the user
            later(failed or _show_error, e)
        else:
            if done:
                later(done, result)
        finally:
            if what:
                later(_busy.discard, what)
    threading.Thread(target=run, daemon=True).start()


def _poll():
    try:
        while True:
            task = _tasks.get_nowait()
            try:
                task()
            except Exception:  # noqa: BLE001
                logger.exception("ICE Grader: a UI update failed")
    except queue.Empty:
        pass
    _wb().after(100, _poll)


def _show_error(e):
    if isinstance(e, (NotSignedIn, SessionExpired)):
        _refresh_panel()
        if messagebox.askyesno("ICE Grader", "%s\n\nSign in now?" % e, master=_wb()):
            cmd_sign_in()
        return
    if isinstance(e, GraderError):
        text = str(e)
    elif isinstance(e, OSError):
        text = "Couldn't reach the grader site (%s). Saved problems, statements and tests still work." % (
            getattr(e, "reason", None) or e)
    else:
        logger.exception("ICE Grader", exc_info=e)
        text = "Something went wrong: %s" % e
    messagebox.showerror("ICE Grader", text, master=_wb())


def _info(text):
    messagebox.showinfo("ICE Grader", text, master=_wb())


# ---------------------------------------------------------------- helpers

def target_python():
    """The Python Thonny runs your programs with (Tools > Options > Interpreter)."""
    exe = None
    try:
        from thonny import get_runner
        proxy = get_runner().get_backend_proxy()
        exe = proxy.get_target_executable() if proxy is not None and hasattr(proxy, "get_target_executable") else None
    except Exception:  # noqa: BLE001 - older Thonny, or no back-end yet
        exe = None
    if not exe or not os.path.exists(exe):
        exe = _wb().get_option("LocalCPython.executable", None)
    if not exe or not os.path.exists(exe):
        exe = sys.executable
    folder, name = os.path.split(exe)
    if name.lower() == "pythonw.exe" and os.path.exists(os.path.join(folder, "python.exe")):
        exe = os.path.join(folder, "python.exe")
    return exe


def open_externally(path):
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])


def current_file(save=True):
    """The file in the current editor, saved first. None (after saying why) if there isn't one."""
    editor = _wb().get_editor_notebook().get_current_editor()
    filename = editor.get_filename() if editor else None
    if not editor or not filename:
        _info("Open your solution file first (save it with the problem's code as its name, e.g. 05_List_15.py).")
        return None
    if save and editor.is_modified():
        filename = editor.save_file() or filename
    return filename


def problem_of(filename):
    p = core().problem_for_file(filename)
    if not p:
        _info("%s isn't linked to a problem.\n\nName the file after the problem's code (e.g. 05_List_15.py), "
              "or double-click the problem in the Grader panel to make its file." % os.path.basename(filename))
    return p


def _panel():
    try:
        return _wb().get_view("GraderView", create=False)
    except Exception:  # noqa: BLE001
        return None


def _refresh_panel():
    view = _panel()
    if view:
        view.fill()


def _results():
    _wb().show_view("GraderResultsView", set_focus=False)
    return _wb().get_view("GraderResultsView")


# ---------------------------------------------------------------- sign-in

class SignInDialog(tk.Toplevel):
    def __init__(self, master, uid=""):
        super().__init__(master)
        self.title("Sign in to the grader")
        self.resizable(False, False)
        self.transient(master)
        self.result = None
        frame = ttk.Frame(self, padding=14)
        frame.grid(sticky="nsew")
        ttk.Label(frame, text="Sign in with your NatteeGrader ID and password.").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))
        ttk.Label(frame, text="ID").grid(row=1, column=0, sticky="w", padx=(0, 8))
        self.uid = ttk.Entry(frame, width=28)
        self.uid.insert(0, uid)
        self.uid.grid(row=1, column=1, sticky="ew", pady=2)
        ttk.Label(frame, text="Password").grid(row=2, column=0, sticky="w", padx=(0, 8))
        self.password = ttk.Entry(frame, width=28, show="•")
        self.password.grid(row=2, column=1, sticky="ew", pady=2)
        buttons = ttk.Frame(frame)
        buttons.grid(row=3, column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="Sign in", command=self.ok, default="active").pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="left")
        self.bind("<Return>", lambda e: self.ok())
        self.bind("<Escape>", lambda e: self.destroy())
        (self.password if uid else self.uid).focus_set()

    def ok(self):
        uid, password = self.uid.get().strip(), self.password.get()
        if uid and password:
            self.result = (uid, password)
            self.destroy()


def cmd_sign_in():
    dlg = SignInDialog(_wb(), core().uid or "")
    dlg.grab_set()
    dlg.wait_window()
    if not dlg.result:
        return
    view = _panel()
    if view:
        view.set_status("Signing in...")

    def done(problems):
        _refresh_panel()
        _wb().show_view("GraderView", set_focus=False)

    def failed(e):
        _refresh_panel()
        _show_error(e)
    in_background(lambda: core().sign_in(*dlg.result), done, "sign_in", failed)


def cmd_sign_out():
    core().sign_out()
    _refresh_panel()


def cmd_refresh():
    if not core().signed_in:
        return cmd_sign_in()
    view = _panel()
    if view:
        view.set_status("Refreshing...")
    in_background(lambda: core().refresh_problems(), lambda _: _refresh_panel(), "refresh")


# ---------------------------------------------------------------- problems

def cmd_open_statement(p=None):
    if p is None:
        filename = current_file(save=False)
        p = filename and problem_of(filename)
        if not p:
            return
    in_background(lambda: core().statement_path(p), open_externally)


def cmd_save_statement(p):
    def save(path):
        ext = os.path.splitext(path)[1]
        target = filedialog.asksaveasfilename(parent=_wb(), title="Save statement", initialfile=safe_name(p["code"]) + ext,
                                              defaultextension=ext, filetypes=[("Statement", "*" + ext), ("All files", "*")])
        if target:
            shutil.copyfile(path, target)
    in_background(lambda: core().statement_path(p), save)


def solutions_dir(ask=True):
    folder = _wb().get_option("ice_grader.solutions_dir")
    if folder and os.path.isdir(folder):
        return folder
    if not ask:
        return None
    _info("Choose the folder for your solution files. Each problem's file goes in a folder for its chapter, "
          "e.g. 05_List/05_List_15.py.")
    start = _wb().get_option("run.working_directory") or os.path.expanduser("~")
    folder = filedialog.askdirectory(parent=_wb(), title="Folder for your solutions", initialdir=start)
    if folder:
        _wb().set_option("ice_grader.solutions_dir", os.path.normpath(folder))
    return folder or None


def find_solution(root, code):
    """A file already named after the problem anywhere in the folder (looked at up to 3 levels deep)."""
    want = (safe_name(code) + ".py").lower()
    base = root.rstrip(os.sep).count(os.sep)
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("venv", "__pycache__", "node_modules")]
        if folder.count(os.sep) - base >= 3:
            dirs[:] = []
        for f in files:
            if f.lower() == want:
                return os.path.join(folder, f)
    return None


def cmd_open_solution(p):
    """Opens the problem's file (making it if needed) and its statement."""
    root = solutions_dir()
    if not root:
        return
    path = find_solution(root, p["code"]) or solution_path(root, p["code"])
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8"):
            pass
    _wb().get_editor_notebook().show_file(path)
    cmd_open_statement(p)


def cmd_change_folder():
    _wb().set_option("ice_grader.solutions_dir", "")
    solutions_dir()


# ---------------------------------------------------------------- tests and submit

def cmd_run_tests():
    if "tests" in _busy:
        return
    filename = current_file()
    p = filename and problem_of(filename)
    if not p:
        return
    if not p.get("has_testcases", True):
        _info("%s has no test cases on the grader. Run it with your own input (F5), then submit it." % p["code"])
        return
    view = _results()
    view.start(p, filename)
    python, limit = target_python(), float(_wb().get_option("ice_grader.time_limit") or 3)

    def work():
        cases = core().tests(p)
        later(view.expect, len(cases))
        return core().run_tests(python, filename, p, limit, lambda i, r: later(view.add, i, cases[i], r))
    in_background(work, lambda result: view.finish(*result), "tests")


def cmd_submit():
    if "submit" in _busy:
        return
    if not core().signed_in:
        return cmd_sign_in()
    filename = current_file()
    p = filename and problem_of(filename)
    if not p:
        return
    if not messagebox.askyesno("ICE Grader", "Submit %s to the grader for %s?\n\nThis is a real submission on your account."
                               % (os.path.basename(filename), p["code"]), master=_wb()):
        return
    with open(filename, encoding="utf-8") as f:
        source = f.read()
    view = _results()
    view.start_submit(p, filename)

    def done(result):
        view.graded(result)
        _refresh_panel()
    in_background(lambda: core().submit(p, source, lambda r: later(view.grading, r)), done, "submit")


# ---------------------------------------------------------------- everything at once

def cmd_download_all():
    if not core().signed_in:
        return cmd_sign_in()
    view = _panel()

    def progress(n, total):
        if view:
            later(view.set_status, "Saving for offline: %d of %d" % (n, total))

    def done(result):
        saved, failed, _ = result
        _refresh_panel()
        if failed:
            _info("Saved %d problems. Couldn't download %s - try again later." % (saved, ", ".join(failed[:5])))
        else:
            _info("All %d problems saved. Everything except Submit now works without the grader site." % saved)
    in_background(lambda: core().download_all(progress), done, "download")


def cmd_export_all():
    if not core().signed_in:
        return cmd_sign_in()
    parent = filedialog.askdirectory(parent=_wb(), title="Where should the statements and your solutions go?",
                                     initialdir=os.path.expanduser("~"))
    if not parent:
        return
    parent = os.path.normpath(parent)
    day = datetime.date.today().isoformat()
    folder = os.path.join(parent, EXPORT_PREFIX + day)
    n = 2
    while os.path.exists(folder):  # a new folder each time, so nothing there is overwritten
        folder = os.path.join(parent, "%s%s-%d" % (EXPORT_PREFIX, day, n))
        n += 1
    view = _panel()

    def progress(n, total):
        if view:
            later(view.set_status, "Downloading: %d of %d" % (n, total))

    def done(result):
        saved, failed, _, solutions = result
        _refresh_panel()
        extra = " Couldn't download %s." % ", ".join(failed[:5]) if failed else ""
        _info("Saved %d statements and %d of your solutions (your latest submission of each) in\n%s%s"
              % (saved, solutions, folder, extra))
        open_externally(folder)
    in_background(lambda: core().export_all(folder, progress), done, "download")


# ---------------------------------------------------------------- the Grader panel

class GraderView(ttk.Frame):
    def __init__(self, master):
        super().__init__(master)
        # The panel is narrow: buttons on one row, who is signed in (wrapped) under them.
        top = ttk.Frame(self, padding=(6, 6, 6, 0))
        top.pack(fill="x")
        self.sign_button = ttk.Button(top, text="Sign in", command=self._sign)
        self.sign_button.pack(side="left", fill="x", expand=True, padx=(0, 4))
        self.refresh_button = ttk.Button(top, text="Refresh", command=cmd_refresh)
        self.refresh_button.pack(side="left", fill="x", expand=True)
        self.who = ttk.Label(self, text="", padding=(8, 4, 6, 4))
        self.who.pack(fill="x")
        self.who.bind("<Configure>", lambda e: self.who.configure(wraplength=max(e.width - 14, 60)))

        middle = ttk.Frame(self)
        middle.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(middle, columns=("status",), show="tree", selectmode="browse")
        # small widths that stretch: a wide first column would push the status column out of sight
        self.tree.column("#0", width=110, minwidth=60, stretch=True)
        self.tree.column("status", width=56, minwidth=40, stretch=False, anchor="e")
        bar = ttk.Scrollbar(middle, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=bar.set)
        self.tree.pack(side="left", fill="both", expand=True)
        bar.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", self._open_selected)
        self.tree.bind("<Return>", self._open_selected)
        self.tree.bind("<Button-3>", self._context_menu)
        if sys.platform == "darwin":
            self.tree.bind("<Button-2>", self._context_menu)

        bottom = ttk.Frame(self, padding=(6, 4, 6, 6))
        bottom.pack(fill="x")
        ttk.Button(bottom, text="Run tests", command=cmd_run_tests).pack(side="left", fill="x", expand=True, padx=(0, 4))
        ttk.Button(bottom, text="Submit", command=cmd_submit).pack(side="left", fill="x", expand=True)

        self.menu = tk.Menu(self, tearoff=False)
        self.fill()
        if core().signed_in:
            cmd_refresh()

    def _sign(self):
        cmd_sign_out() if core().signed_in else cmd_sign_in()

    def set_status(self, text):
        self.who.configure(text=text)

    def fill(self):
        c = core()
        self.sign_button.configure(text="Sign out" if c.signed_in else "Sign in")
        self.set_status(("Signed in as %s" % c.uid) if c.signed_in else
                        ("Not signed in - saved problems shown" if c.problems else "Sign in to see your problems"))
        opened = {i for i in self.tree.get_children() if self.tree.item(i, "open")}
        selected = self.tree.selection()
        self.tree.delete(*self.tree.get_children())
        chapters = {}
        for p in sorted(c.problems, key=lambda p: p["code"].lower()):
            chapters.setdefault(chapter_of(p["code"]), []).append(p)
        for name in sorted(chapters, key=_natural):  # 00_Intro ... 08_Dict, Exam1, Exam2 (before Exam10), P1_07
            problems = chapters[name]
            solved = sum(1 for p in problems if p["status"] == "solved")
            cid = "ch:" + name
            self.tree.insert("", "end", iid=cid, text=name, values=("%d/%d" % (solved, len(problems)),), open=cid in opened)
            for p in problems:
                self.tree.insert(cid, "end", iid="p:" + p["id"], text=p["code"], values=(self._status(p),))
        if selected and self.tree.exists(selected[0]):
            self.tree.selection_set(selected[0])
            self.tree.see(selected[0])

    @staticmethod
    def _status(p):
        if not p.get("has_testcases", True):
            return "no tests"
        if p["status"] == "solved":
            return "✓"
        if p["status"] == "inprogress":
            return "● %g" % p["score"]
        return ""

    def _problem(self, iid):
        return next((p for p in core().problems if "p:" + p["id"] == iid), None) if iid else None

    def _open_selected(self, event=None):
        sel = self.tree.selection()
        p = self._problem(sel[0] if sel else None)
        if p:
            cmd_open_solution(p)
            return "break"
        return None

    def _context_menu(self, event):
        iid = self.tree.identify_row(event.y)
        p = self._problem(iid)
        if not p:
            return
        self.tree.selection_set(iid)
        self.menu.delete(0, "end")
        self.menu.add_command(label="Open solution file and statement", command=lambda: cmd_open_solution(p))
        self.menu.add_command(label="Open statement", command=lambda: cmd_open_statement(p))
        self.menu.add_command(label="Save statement as...", command=lambda: cmd_save_statement(p))
        self.menu.tk_popup(event.x_root, event.y_root)


# ---------------------------------------------------------------- the Test Results panel

class GraderResultsView(ttk.Frame):
    def __init__(self, master):
        super().__init__(master)
        from thonny.tktextext import TextFrame
        frame = TextFrame(self, read_only=True, wrap="word", horizontal_scrollbar=False, borderwidth=0)
        frame.pack(fill="both", expand=True)
        self.text = frame.text
        for verdict, color in COLORS.items():
            self.text.tag_configure(verdict, foreground=color)
        bold = tkfont.Font(font=self.text["font"])
        bold.configure(weight="bold")
        self.text.tag_configure("title", font=bold)
        self.text.tag_configure("dim", foreground="#8b949e")
        self.total = 0
        self.passed = 0
        self.write("Run tests (Grader > Run tests, or the button in the Grader panel) to see the results here.\n", "dim")

    def clear(self):
        self.text.direct_delete("1.0", "end")

    def write(self, s, *tags):
        self.text.direct_insert("end", s, tags)
        self.text.see("end")

    def start(self, p, filename):
        self.clear()
        self.passed = 0
        self.write("%s - running %s\n" % (p["code"], os.path.basename(filename)), "title")

    def expect(self, n):
        self.total = n

    def add(self, i, tc, r):
        verdict = r["verdict"]
        if verdict == "PASS":
            self.passed += 1
        self.write("\nTest %d of %d  " % (i + 1, self.total))
        self.write(verdict, verdict)
        self.write("  %d ms\n" % r["ms"], "dim")
        if verdict == "SKIP":
            why = ("the grader shows only the start of its input" if r.get("skipped") == "input"
                   else "the grader shows too little of its expected output")
            self.write("  Can't check here: %s. Submit to check it.\n" % why, "dim")
        elif verdict == "TLE":
            self.write("  Took longer than the time limit (an endless loop, or waiting for input that isn't there).\n")
        elif verdict == "RE":
            err = r["stderr"].strip().splitlines()
            self.write("  Crashed:\n", "FAIL")
            self.write("".join("    %s\n" % line for line in err[-6:]) or "    (no error message)\n")
        if verdict in ("FAIL", "RE", "TLE"):
            self.write("  Input:\n", "dim")
            self.write(_indent(tc["input"], 12))
        if verdict == "FAIL":
            cmp = compared_outputs(tc, r["stdout"])
            diff = first_difference(cmp["expected"], cmp["actual"])
            self.write("  Expected:\n", "dim")
            self.write(_indent(cmp["expected"], 12))
            self.write("  Your output:\n", "dim")
            self.write(_indent(cmp["actual"], 12) if cmp["actual"].strip() else "    (nothing)\n")
            if diff:
                self.write("  " + _explain(diff) + "\n", "FAIL")

    def finish(self, cases, results):
        # The summary goes at the top, under the title, and the view scrolls back up to it and the first failure.
        n = len(results)
        skipped = sum(1 for r in results if r["verdict"] == "SKIP")
        tag = "PASS" if self.passed + skipped == n and self.passed else "FAIL"
        extra = " (%d skipped)" % skipped if skipped else ""
        self.text.direct_insert("2.0", "%d of %d passed%s\n" % (self.passed, n, extra), (tag, "title"))
        self.text.see("1.0")

    def start_submit(self, p, filename):
        self.clear()
        self.write("%s - submitting %s...\n" % (p["code"], os.path.basename(filename)), "title")

    def grading(self, r):
        self.clear()
        self.write("Grading... %s\n" % (r["status"] or ""), "dim")

    def graded(self, r):
        self.clear()
        if r["points"] is not None:
            tag = "PASS" if r["points"] == r["max"] else "FAIL"
            self.write("Submission #%s: %g / %g points\n" % (r["id"], r["points"], r["max"]), tag, "title")
        else:
            self.write("Submission #%s\n" % r["id"], "title")
        if r.get("timed_out"):
            self.write("Still grading - check the grader site for the result.\n", "dim")
        for t in r["tests"]:
            good = t["letter"].strip().upper() in ("P", "")
            self.write("Test %d: %s\n" % (t["n"], t["label"]), "PASS" if good else "FAIL")


def _natural(s):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", s)]


def _indent(s, max_lines):
    lines = s.rstrip("\n").split("\n")
    shown = lines[:max_lines]
    more = "    ... %d more lines\n" % (len(lines) - max_lines) if len(lines) > max_lines else ""
    return "".join("    %s\n" % line for line in shown) + more


def _explain(d):
    if d["kind"] == "missing":
        return "Line %d is missing: expected %r" % (d["line"], d["expected"])
    if d["kind"] == "extra":
        return "Line %d is extra: you printed %r" % (d["line"], d["actual"])
    if d["spacing_only"]:
        return "Line %d differs only in spaces: expected %s, you printed %s" % (
            d["line"], visible(d["expected"]), visible(d["actual"]))
    return "Line %d differs at column %d: expected %r, you printed %r" % (
        d["line"], d["index"] + 1, d["expected"], d["actual"])


# ---------------------------------------------------------------- plug-in entry point

def load_plugin():
    # Never let a problem here stop Thonny from starting.
    try:
        wb = _wb()
        wb.set_default("ice_grader.root_url", DEFAULT_ROOT)
        wb.set_default("ice_grader.time_limit", 3)
        wb.set_default("ice_grader.solutions_dir", "")
        wb.add_view(GraderView, "Grader", "nw", visible_by_default=True)
        wb.add_view(GraderResultsView, "Test Results", "s")
        commands = [
            ("run_tests", "Run tests on this file", cmd_run_tests, 10),
            ("submit", "Submit this file...", cmd_submit, 10),
            ("open_statement", "Open this file's statement", cmd_open_statement, 10),
            ("refresh", "Refresh problems", cmd_refresh, 20),
            ("download_all", "Download all for offline", cmd_download_all, 20),
            ("export_all", "Download all statements and my solutions...", cmd_export_all, 20),
            ("change_folder", "Change solutions folder...", cmd_change_folder, 30),
            ("sign_in", "Sign in...", cmd_sign_in, 30),
            ("sign_out", "Sign out", cmd_sign_out, 30),
        ]
        for cid, label, handler, group in commands:
            wb.add_command("ice_grader_" + cid, MENU, label, handler, group=group)
        wb.after(100, _poll)
    except Exception:  # noqa: BLE001
        logger.exception("ICE Grader plug-in failed to load")
