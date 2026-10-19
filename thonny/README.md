# ICE Nattee Grader for Thonny

The NatteeGrader website (Chula 2190101) inside Thonny: see your problems, open statements, run the grader's tests
on your code and submit, without leaving Thonny.

## Features
- **Grader panel** with your problems by chapter and your progress: solved, in progress (with your best score) and
  `solved/total` per chapter. Exam practice problems are grouped as Exam1, Exam2, ...
- **Double-click a problem** to open its solution file (made for you as `05_List/05_List_15.py`) and its statement.
- **Run tests**: PASS / FAIL / TLE / RE for each test. A wrong answer shows the input, the expected output, yours,
  and the first line that differs.
- **Submit** from Thonny: it always asks first, then shows the grader's points and each test's result.
- **Works offline**: Grader > Download all for offline saves every statement and test, so everything except Submit
  works when the grader site is down.
- **Download all statements and your solutions** (Grader menu).

## Install
In Thonny: **Tools > Manage plug-ins...**, search **thonny-ice-grader**, click Install and restart Thonny.
Needs Thonny 4.0 or newer.

## Use
1. In the **Grader** panel (View > Grader if it's hidden), click **Sign in**.
2. Double-click a problem. The first time, choose the folder for your solutions.
3. Click **Run tests** (or Grader > Run tests on this file).

Any file named after a problem's code (e.g. `05_List_15.py`) belongs to that problem.

## Good to know
- The grader shows only the first 2 KB of each test. A test with a longer input shows as SKIP: submit to check it.
- Your password is never saved. The sign-in is remembered like a browser does, until you sign out.
- Tests run with the Python Thonny uses for your programs.

## License
MIT.

Unofficial student tool. It only reads what your own grader account can see and keeps it on your computer.
Check your course's rules before using it.
