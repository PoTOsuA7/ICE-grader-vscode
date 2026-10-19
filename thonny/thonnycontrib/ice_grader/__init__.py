"""ICE Nattee Grader for Thonny: the NatteeGrader website inside Thonny. A "Grader" panel lists your problems with
your progress, the "Statement" panel shows a problem's PDF beside your code, and the plug-in runs the grader's tests
on your code (also each time you save), explains a failure with AI, and submits."""
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
import webbrowser
from tkinter import filedialog, messagebox, ttk
from tkinter import font as tkfont

from .ai import DEFAULT_MODEL, FALLBACK_MODEL, AIError, build_prompt, call_gemini
from .client import GraderError, SessionExpired
from .clipboard import copy_file
from .core import DEFAULT_ROOT, Core, NotSignedIn
from .diff import compared_outputs, first_difference, visible
from .layout import chapter_of, safe_name, solution_path
from .statement import StatementView, can_show_pdfs

logger = logging.getLogger(__name__)

MENU = "Grader"
EXPORT_PREFIX = "ice-grader-export-"
GEMINI_SECRET = "gemini"
COLORS = {"PASS": "#2ea043", "FAIL": "#e5534b", "RE": "#e5534b", "TLE": "#d29922", "SKIP": "#8b949e"}
FAILED = ("FAIL", "RE", "TLE")

_core = None
_tasks = queue.Queue()
_busy = set()  # what is running now: "tests", "submit", "download", "ai", ...
_last_run = None  # the latest test run, for Explain: {problem, filename, code, cases, results}
_session_gemini_key = None  # when the computer has no password store


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
# Network, PDF drawing and test runs happen in a thread; what they report is handed back to Tk's thread through a
# queue.

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


def _error_text(e):
    if isinstance(e, (GraderError, AIError)):
        return str(e)
    if isinstance(e, OSError):
        return "Couldn't reach the grader site (%s). Saved problems, statements and tests still work." % (
            getattr(e, "reason", None) or e)
    logger.exception("ICE Grader", exc_info=e)
    return "Something went wrong: %s" % e


def _show_error(e):
    if isinstance(e, (NotSignedIn, SessionExpired)):
        _refresh_panel()
        if messagebox.askyesno("ICE Grader", "%s\n\nSign in now?" % e, master=_wb()):
            cmd_sign_in()
        return
    messagebox.showerror("ICE Grader", _error_text(e), master=_wb())


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


def _view(view_id):
    """The view if Thonny has made it, else None."""
    try:
        return _wb().get_view(view_id, create=False)
    except Exception:  # noqa: BLE001
        return None


def _visible(view):
    return view is not None and not getattr(view, "hidden", True)


def _panel():
    return _view("GraderView")


def _refresh_panel():
    view = _panel()
    if view:
        view.fill()


def _results(show=True):
    if show:
        _wb().show_view("GraderResultsView", set_focus=False)
    return _wb().get_view("GraderResultsView")


def current_file(save=True):
    """The file in the current editor, saved first. None (after saying why) if there isn't one."""
    editor = _wb().get_editor_notebook().get_current_editor()
    filename = editor.get_filename() if editor else None
    if not editor or not filename:
        _info("Open your solution file first, or double-click a problem in the Grader panel to make it.")
        return None
    if save and editor.is_modified():
        filename = editor.save_file() or filename
    return filename


def problem_of(filename):
    """The file's problem. A file that isn't linked yet: ask which problem it is for, and remember it."""
    p = core().problem_for_file(filename)
    if p:
        return p
    if not core().problems:
        _info("Sign in first, so your problems can be listed.")
        return None
    p = pick_problem("Which problem is %s for?" % os.path.basename(filename))
    if p:
        core().link(filename, p)
    return p


# ---------------------------------------------------------------- dialogs

class _Dialog(tk.Toplevel):
    def __init__(self, master, title):
        super().__init__(master)
        self.title(title)
        self.transient(master)
        self.result = None
        self.frame = ttk.Frame(self, padding=14)
        self.frame.pack(fill="both", expand=True)
        self.bind("<Escape>", lambda e: self.destroy())

    def run(self):
        self.grab_set()
        self.wait_window()
        return self.result


class SignInDialog(_Dialog):
    def __init__(self, master, uid=""):
        super().__init__(master, "Sign in to the grader")
        self.resizable(False, False)
        f = self.frame
        ttk.Label(f, text="Sign in with your NatteeGrader ID and password.").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))
        ttk.Label(f, text="ID").grid(row=1, column=0, sticky="w", padx=(0, 8))
        self.uid = ttk.Entry(f, width=28)
        self.uid.insert(0, uid)
        self.uid.grid(row=1, column=1, sticky="ew", pady=2)
        ttk.Label(f, text="Password").grid(row=2, column=0, sticky="w", padx=(0, 8))
        self.password = ttk.Entry(f, width=28, show="•")
        self.password.grid(row=2, column=1, sticky="ew", pady=2)
        ttk.Label(f, text="Your password is kept in your computer's password store, not in a file.",
                  foreground="#8b949e").grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
        buttons = ttk.Frame(f)
        buttons.grid(row=4, column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(buttons, text="Sign in", command=self.ok, default="active").pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="left")
        self.bind("<Return>", lambda e: self.ok())
        (self.password if uid else self.uid).focus_set()

    def ok(self):
        uid, password = self.uid.get().strip(), self.password.get()
        if uid and password:
            self.result = (uid, password)
            self.destroy()


class ProblemPicker(_Dialog):
    """Pick a problem from the list, typing part of its code to narrow it down."""

    def __init__(self, master, prompt):
        super().__init__(master, "Link to a problem")
        self.geometry("380x420")
        f = self.frame
        ttk.Label(f, text=prompt, wraplength=340).pack(fill="x")
        self.search = ttk.Entry(f)
        self.search.pack(fill="x", pady=(8, 4))
        self.search.bind("<KeyRelease>", lambda e: self.fill())
        self.search.bind("<Down>", lambda e: (self.list.focus_set(), self.list.selection_set(0)))
        self.list = tk.Listbox(f, activestyle="none", exportselection=False)
        self.list.pack(fill="both", expand=True)
        self.list.bind("<Double-1>", lambda e: self.ok())
        buttons = ttk.Frame(f)
        buttons.pack(fill="x", pady=(10, 0))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right")
        ttk.Button(buttons, text="Link", command=self.ok, default="active").pack(side="right", padx=(0, 6))
        self.bind("<Return>", lambda e: self.ok())
        self.shown = []
        self.fill()
        self.search.focus_set()

    def fill(self):
        text = self.search.get().strip().lower()
        self.shown = [p for p in sorted(core().problems, key=lambda p: _natural(p["code"]))
                      if text in p["code"].lower() or text in p.get("name", "").lower()]
        self.list.delete(0, "end")
        for p in self.shown:
            self.list.insert("end", p["code"])
        if self.shown:
            self.list.selection_set(0)

    def ok(self):
        sel = self.list.curselection()
        if sel:
            self.result = self.shown[sel[0]]
            self.destroy()


def pick_problem(prompt):
    return ProblemPicker(_wb(), prompt).run()


class KeyDialog(_Dialog):
    def __init__(self, master):
        super().__init__(master, "Gemini API key")
        self.resizable(False, False)
        f = self.frame
        ttk.Label(f, text="Explain uses Google's Gemini with your own free API key.", wraplength=380).pack(anchor="w")
        link = ttk.Label(f, text="Get one at aistudio.google.com (Get API key)", foreground="#3b82f6", cursor="hand2")
        link.pack(anchor="w", pady=(4, 0))
        link.bind("<Button-1>", lambda e: webbrowser.open("https://aistudio.google.com/apikey"))
        ttk.Label(f, text="School Google accounts may have AI Studio switched off; a personal account works.",
                  foreground="#8b949e", wraplength=380).pack(anchor="w", pady=(4, 8))
        self.key = ttk.Entry(f, width=48, show="•")
        self.key.pack(fill="x")
        ttk.Label(f, text="Leave it empty and click Save to remove your key.", foreground="#8b949e").pack(anchor="w", pady=(4, 0))
        buttons = ttk.Frame(f)
        buttons.pack(fill="x", pady=(12, 0))
        ttk.Button(buttons, text="Cancel", command=self.destroy).pack(side="right")
        ttk.Button(buttons, text="Save", command=self.ok, default="active").pack(side="right", padx=(0, 6))
        self.bind("<Return>", lambda e: self.ok())
        self.key.focus_set()

    def ok(self):
        self.result = self.key.get().strip()
        self.destroy()


# ---------------------------------------------------------------- sign-in

def cmd_sign_in():
    result = SignInDialog(_wb(), core().uid or "").run()
    if not result:
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
    in_background(lambda: core().sign_in(*result), done, "sign_in", failed)


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


# ---------------------------------------------------------------- statements

def show_statement(p):
    """The problem's statement in the Statement panel (or the PDF app, if this computer can't draw PDFs)."""
    if not can_show_pdfs():
        in_background(lambda: core().statement_path(p), open_externally)
        return
    _wb().show_view("StatementView", set_focus=False)
    view = _wb().get_view("StatementView")
    view.title.configure(text="%s - loading..." % p["code"])
    in_background(lambda: core().statement_path(p), lambda path: view.show(p, path),
                  failed=lambda e: (view.title.configure(text=p["code"]), _show_error(e)))


def cmd_open_statement():
    filename = current_file(save=False)
    p = filename and problem_of(filename)
    if p:
        show_statement(p)


def statement_copy(view):
    """The Copy button: puts the PDF itself on the clipboard (named after the problem), to paste into a chat or
    an AI as an attachment."""
    p = view.problem
    if not p:
        return view.flash("Open a statement first.")

    def work():
        path = core().clipboard_copy(p)
        copy_file(path)
        return os.path.basename(path)
    in_background(work, lambda name: view.flash("Copied %s - paste it into a chat or an AI (Ctrl+V)." % name), "copy",
                  lambda e: view.flash("Couldn't copy the PDF (%s). Use Save instead." % e))


def statement_save(view):
    if not view.path:
        return view.flash("Open a statement first.")
    ext = os.path.splitext(view.path)[1]
    target = filedialog.asksaveasfilename(parent=_wb(), title="Save statement", initialfile=view.file_name(),
                                          defaultextension=ext, filetypes=[("Statement", "*" + ext), ("All files", "*")])
    if target:
        shutil.copyfile(view.path, target)
        view.flash("Saved %s." % os.path.basename(target))


def statement_open(view):
    if view.path:
        open_externally(view.path)


def cmd_save_statement(p):
    def save(path):
        ext = os.path.splitext(path)[1]
        target = filedialog.asksaveasfilename(parent=_wb(), title="Save statement", initialfile=safe_name(p["code"]) + ext,
                                              defaultextension=ext, filetypes=[("Statement", "*" + ext), ("All files", "*")])
        if target:
            shutil.copyfile(path, target)
    in_background(lambda: core().statement_path(p), save)


def _on_editor_changed(event=None):
    """Switching to another solution file shows its statement, if the Statement panel is open."""
    view = _view("StatementView")
    if not _visible(view):
        return
    editor = _wb().get_editor_notebook().get_current_editor()
    filename = editor.get_filename() if editor else None
    p = core().problem_for_file(filename) if filename else None
    if p and (not view.problem or view.problem["id"] != p["id"]):
        show_statement(p)


# ---------------------------------------------------------------- solution files

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


def find_solution(root, p):
    """The problem's file: one linked to it, else one named after it anywhere in the folder (3 levels deep)."""
    for path, pid in core().links.items():
        if pid == p["id"] and os.path.exists(path):
            return path
    want = (safe_name(p["code"]) + ".py").lower()
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
    path = find_solution(root, p) or solution_path(root, p["code"])
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8"):
            pass
    _wb().get_editor_notebook().show_file(path)
    show_statement(p)


def cmd_change_folder():
    _wb().set_option("ice_grader.solutions_dir", "")
    solutions_dir()


def cmd_link_file(p=None):
    """Link the current file to a problem (asked for, unless given), whatever the file's name."""
    filename = current_file(save=False)
    if not filename:
        return
    if not core().problems:
        return _info("Sign in first, so your problems can be listed.")
    p = p or pick_problem("Which problem is %s for?" % os.path.basename(filename))
    if p:
        core().link(filename, p)
        view = _panel()
        if view:
            view.set_last("%s is now linked to %s." % (os.path.basename(filename), p["code"]))


# ---------------------------------------------------------------- tests

def run_tests_for(filename, p, show=True):
    """Runs the problem's tests on the file. show=False (on save): the results are filled in without switching to
    the Test Results tab, so the Shell stays in front, and the Grader panel shows the score."""
    if "tests" in _busy:  # e.g. Run tests saved the file, which started a run already: show that one
        if show:
            _results()
        return
    if not p.get("has_testcases", True):
        if show:
            _info("%s has no test cases on the grader. Run it with your own input (F5), then submit it." % p["code"])
        return
    view = _results(show)
    view.start(p, filename)
    try:
        with open(filename, encoding="utf-8") as f:
            code = f.read()
    except OSError:
        code = ""
    python, limit = target_python(), float(_wb().get_option("ice_grader.time_limit") or 3)
    panel = _panel()
    if panel:
        panel.set_last("Testing %s..." % p["code"])

    def work():
        cases = core().tests(p)
        later(view.expect, len(cases))
        return core().run_tests(python, filename, p, limit, lambda i, r: later(view.add, i, cases[i], r))

    def done(result):
        global _last_run
        cases, results = result
        _last_run = {"problem": p, "filename": filename, "code": code, "cases": cases, "results": results}
        summary, tag = view.finish(cases, results)
        if panel:
            panel.set_last("%s: %s" % (p["code"], summary), COLORS[tag])

    def failed(e):
        if panel:
            panel.set_last("")
        view.failed(_error_text(e))
        _show_error(e) if show or isinstance(e, (NotSignedIn, SessionExpired)) else None
    in_background(work, done, "tests", failed)


def cmd_run_tests():
    filename = current_file()
    p = filename and problem_of(filename)
    if p:
        run_tests_for(filename, p)


def cmd_toggle_run_on_save():
    var = _wb().get_variable("ice_grader.run_on_save")
    var.set(not var.get())


def _on_save(event):
    if not _wb().get_option("ice_grader.run_on_save"):
        return
    filename = getattr(event, "filename", None)
    p = core().problem_for_file(filename) if filename else None
    if p and p.get("has_testcases", True):
        run_tests_for(filename, p, show=False)


# ---------------------------------------------------------------- AI explain

def gemini_key(ask=True):
    global _session_gemini_key
    key = _session_gemini_key or core().secrets.get(GEMINI_SECRET)
    if key or not ask:
        return key
    return cmd_set_gemini_key()


def cmd_set_gemini_key():
    global _session_gemini_key
    key = KeyDialog(_wb()).run()
    if key is None:
        return None
    if not key:
        core().secrets.delete(GEMINI_SECRET)
        _session_gemini_key = None
        _info("Your Gemini API key was removed.")
        return None
    if not core().secrets.set(GEMINI_SECRET, key):
        _session_gemini_key = key  # no password store: keep it until Thonny closes
    return key


def cmd_explain():
    run = _last_run
    failures = []
    if run:
        for i, (tc, r) in enumerate(zip(run["cases"], run["results"])):
            if r["verdict"] in FAILED:
                failures.append({"n": i + 1, "verdict": r["verdict"], "input": tc["input"], "expected": tc["output"],
                                 "partial_output": tc.get("partial_output"), "actual": r["stdout"], "stderr": r["stderr"]})
    if not failures:
        return _info("Run the tests first. Explain is for a test that fails.")
    if not _wb().get_option("ice_grader.ai_ok"):
        if not messagebox.askyesno("ICE Grader", "Explain sends your code and the failing tests to Google's Gemini, using "
                                   "your own API key. It explains the bug in words and writes no code.\n\nOn the free "
                                   "tier Google may use what you send to improve its products. Check your course's "
                                   "rules on AI before using it.\n\nContinue?", master=_wb()):
            return
        _wb().set_option("ice_grader.ai_ok", True)
    key = gemini_key()
    if not key:
        return
    p = run["problem"]
    prompt = build_prompt(run["code"], failures, len(failures), p, (run["cases"][0] or {}).get("files") if run["cases"] else None)
    models = [_wb().get_option("ice_grader.gemini_model") or DEFAULT_MODEL,
              _wb().get_option("ice_grader.gemini_fallback_model") or FALLBACK_MODEL]
    view = _results()
    view.explaining(min(len(failures), 3), len(failures))
    in_background(lambda: call_gemini(key, models, prompt), view.explained, "ai", lambda e: view.explain_failed(_error_text(e)))


# ---------------------------------------------------------------- submit

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
        self.who = _wrapping_label(self)
        self.who.pack(fill="x")

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

        # the latest test result (also from saving), click it for the details
        self.last = _wrapping_label(self, cursor="hand2")
        self.last.pack(fill="x")
        self.last.bind("<Button-1>", lambda e: _results())
        bottom = ttk.Frame(self, padding=(6, 0, 6, 6))
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

    def set_last(self, text, color=""):
        self.last.configure(text=text, foreground=color)

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
        self.menu.add_command(label="Show statement", command=lambda: show_statement(p))
        self.menu.add_command(label="Save statement as...", command=lambda: cmd_save_statement(p))
        self.menu.add_separator()
        self.menu.add_command(label="Link the current file to this problem", command=lambda: cmd_link_file(p))
        self.menu.tk_popup(event.x_root, event.y_root)


def _wrapping_label(master, **kw):
    label = ttk.Label(master, text="", padding=(8, 4, 6, 4), **kw)
    label.bind("<Configure>", lambda e: label.configure(wraplength=max(e.width - 14, 60)))
    return label


# ---------------------------------------------------------------- the Test Results panel

class GraderResultsView(ttk.Frame):
    def __init__(self, master):
        super().__init__(master)
        from thonny.tktextext import TextFrame
        bar = ttk.Frame(self, padding=(6, 4, 6, 2))
        bar.pack(fill="x")
        # an explicit width: Thonny's theme gives buttons a short fixed one, which would cut the text
        self.explain_button = ttk.Button(bar, text="Explain failure (AI)", command=cmd_explain, state="disabled", width=20)
        self.explain_button.pack(side="left")
        self.hint = ttk.Label(bar, text="", foreground="#8b949e")
        self.hint.pack(side="left", padx=(8, 0))
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
        self.write("Run tests (the button in the Grader panel, or save your file) to see the results here.\n", "dim")

    def clear(self):
        self.text.direct_delete("1.0", "end")

    def write(self, s, *tags):
        self.text.direct_insert("end", s, tags)
        self.text.see("end")

    def start(self, p, filename):
        self.clear()
        self.passed = 0
        self.explain_button.configure(state="disabled")
        self.hint.configure(text="")
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
        if verdict in FAILED:
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
        """The summary goes at the top, under the title, and the view scrolls back up to it. -> (summary, tag)"""
        n = len(results)
        skipped = sum(1 for r in results if r["verdict"] == "SKIP")
        failing = sum(1 for r in results if r["verdict"] in FAILED)
        tag = "PASS" if self.passed + skipped == n and self.passed else "FAIL"
        summary = "%d of %d passed%s" % (self.passed, n, " (%d skipped)" % skipped if skipped else "")
        self.text.direct_insert("2.0", summary + "\n", (tag, "title"))
        self.text.see("1.0")
        if failing:
            self.explain_button.configure(state="normal")
            self.hint.configure(text="AI explains why %s fails, in words" % ("this test" if failing == 1 else "these tests"))
        return summary, tag

    def failed(self, text):
        self.write("\n" + text + "\n", "FAIL")

    def explaining(self, shown, total):
        self.explain_button.configure(state="disabled")
        self.write("\n\nAsking Gemini about %s...\n" % ("the failing test" if total == 1 else
                                                        "%d of the %d failing tests" % (shown, total)), "dim")

    def explained(self, result):
        self.explain_button.configure(state="normal")
        self.write("\nAI explanation (%s%s):\n" % (result["model"], ", the first model was busy" if result["fallback"] else ""), "title")
        self.write(result["text"] + "\n")

    def explain_failed(self, text):
        self.explain_button.configure(state="normal")
        self.write("\n" + text + "\n", "FAIL")

    def start_submit(self, p, filename):
        self.clear()
        self.explain_button.configure(state="disabled")
        self.hint.configure(text="")
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

def _after_start():
    try:
        _wb().get_editor_notebook().bind("<<NotebookTabChanged>>", _on_editor_changed, True)
    except Exception:  # noqa: BLE001
        logger.exception("ICE Grader: couldn't follow the editor tabs")


def load_plugin():
    # Never let a problem here stop Thonny from starting.
    try:
        wb = _wb()
        wb.set_default("ice_grader.root_url", DEFAULT_ROOT)
        wb.set_default("ice_grader.time_limit", 3)
        wb.set_default("ice_grader.solutions_dir", "")
        wb.set_default("ice_grader.run_on_save", True)
        wb.set_default("ice_grader.gemini_model", DEFAULT_MODEL)
        wb.set_default("ice_grader.gemini_fallback_model", FALLBACK_MODEL)
        wb.set_default("ice_grader.ai_ok", False)
        wb.add_view(GraderView, "Grader", "nw", visible_by_default=True)
        wb.add_view(StatementView, "Statement", "ne")
        wb.add_view(GraderResultsView, "Test Results", "s")
        commands = [
            ("run_tests", "Run tests on this file", cmd_run_tests, 10),
            ("submit", "Submit this file...", cmd_submit, 10),
            ("open_statement", "Show this file's statement", cmd_open_statement, 10),
            ("explain", "Explain failure (AI)", cmd_explain, 10),
            ("link", "Link this file to a problem...", cmd_link_file, 20),
            ("refresh", "Refresh problems", cmd_refresh, 30),
            ("download_all", "Download all for offline", cmd_download_all, 30),
            ("export_all", "Download all statements and my solutions...", cmd_export_all, 30),
            ("change_folder", "Change solutions folder...", cmd_change_folder, 40),
            ("gemini_key", "Set Gemini API key...", cmd_set_gemini_key, 40),
            ("sign_in", "Sign in...", cmd_sign_in, 50),
            ("sign_out", "Sign out", cmd_sign_out, 50),
        ]
        for cid, label, handler, group in commands:
            wb.add_command("ice_grader_" + cid, MENU, label, handler, group=group)
        wb.add_command("ice_grader_run_on_save", MENU, "Run tests when saving", cmd_toggle_run_on_save,
                       flag_name="ice_grader.run_on_save", group=20)
        wb.bind("Save", _on_save, True)
        wb.after(100, _poll)
        wb.after(500, _after_start)
    except Exception:  # noqa: BLE001
        logger.exception("ICE Grader plug-in failed to load")
