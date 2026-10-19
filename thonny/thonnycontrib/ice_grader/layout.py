"""Problem codes: grouping into chapters, and where solution files go."""
import os
import re

_EXAM = re.compile(r"(?<![a-z])exam(?![a-z])", re.I)
_EXAM_NUMBER = re.compile(r"(?<![a-z])exam[\s_-]*(\d+)", re.I)


def safe_name(s):
    """A file or folder name made from a problem code. Never "." or ".." (or empty), which would point outside."""
    name = re.sub(r"[^\w\-.]+", "_", s, flags=re.ASCII)
    name = re.sub(r"_+", "_", name).strip("_")
    return "problem" if not name or re.fullmatch(r"\.+", name) else name


def is_exam(code):
    """Exam practice problems, e.g. 2025s1_Exam2_A1-1_Student or Exam1-2024_Q1A_student (not "Example")."""
    return bool(_EXAM.search(code))


def chapter_of(code):
    """05_List_15 -> 05_List; exam problems go together by exam number: Exam1, Exam2, ..."""
    m = _EXAM_NUMBER.search(code)
    if m:
        return "Exam%d" % int(m.group(1))
    if is_exam(code):
        return "Exam"
    return "_".join(code.split("_")[:2]) or code


def solution_path(root, code, ext=".py"):
    """New solution file: <root>/<chapter>/<code>.py"""
    return os.path.join(root, safe_name(chapter_of(code)), safe_name(code) + ext)
