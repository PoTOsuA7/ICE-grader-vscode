# ICE Nattee Grader for Thonny

The NatteeGrader website (Chula 2190101) inside Thonny: see your problems, read the statement beside your code, run
the grader's tests and submit, without leaving Thonny.

## Features
- **Grader panel** with your problems by chapter and your progress: solved, in progress (with your best score) and
  `solved/total` per chapter. Exam practice problems are grouped as Exam1, Exam2, ...
- **Double-click a problem** to open its solution file (made for you as `05_List/05_List_15.py`) and its statement.
- **Statement panel** beside your code, with zoom. **Copy** puts the PDF itself on the clipboard, to paste into a
  chat or an AI; **Save** and **Open** (in your PDF app) are there too. Switching files shows each one's statement.
- **Run tests**, or just save: PASS / FAIL / TLE / RE for each test. A wrong answer shows the input, the expected
  output, yours, and the first line that differs. On save the Shell stays in front and the Grader panel shows the score.
- **Explain failure (AI)**: Google's Gemini explains why a test fails, in words, without writing code. It uses your own
  free API key from [aistudio.google.com](https://aistudio.google.com) (Grader > Set Gemini API key). Nothing is sent
  until you click it. Check your course's rules on AI first.
- **Any file name**: a file named after a problem's code belongs to it; any other file is linked once (you pick the
  problem the first time you run its tests).
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
3. Save your file, or click **Run tests**.

## Good to know
- The grader shows only the first 2 KB of each test. A test with a longer input shows as SKIP: submit to check it.
- Your password and Gemini key are kept in your computer's password store (Windows Credential Manager, the macOS
  Keychain), never in a file. Sign out removes the password.
- On Gemini's free tier Google may use what you send to improve its products.
- Tests run with the Python Thonny uses for your programs. Turn off testing on save in the Grader menu.

## License
MIT. Uses pypdfium2 (Apache-2.0 / BSD-3-Clause) and keyring (MIT).

Unofficial student tool. It only reads what your own grader account can see and keeps it on your computer.
Check your course's rules before using it.
