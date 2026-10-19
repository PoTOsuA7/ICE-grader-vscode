# ICE Nattee Grader for VS Code

The NatteeGrader website inside VS Code: read the problems, test your code and submit without leaving the editor.

## Features
- **Problem list** in the sidebar by chapter, with your progress: solved, in progress (with your best score) and
  `solved/total` per chapter. Exam practice problems are grouped as Exam1, Exam2, ...
- **Statements** open beside your code, with Copy and Save buttons.
- **Run tests** with ▶ or on save: PASS / FAIL / TLE / RE for each case, and a wrong answer shows the first
  difference.
- **Run one test or your own input** (`Nattee: Run One Test or Custom Input`).
- **Run in Terminal**: type the input yourself, like in Thonny.
- **Mock exam** (the stopwatch button): random problems and a timer. No tests, AI or submit until you hand in, then
  your answers are marked with the grader's tests.
- **Submit** (the cloud button): always asks first, then shows the grader's result live.
- **Works offline**: press **Download All for Offline** while the grader site is up, then everything except Submit
  works without it.
- **Download all statements and your solutions** (`Nattee: Download All Statements and My Solutions`).
- **Explain a failure with AI** (✨): Google's Gemini explains why a test fails, in words, without writing code.
  Uses your own free API key from [aistudio.google.com](https://aistudio.google.com)
  (`Nattee: Set Gemini API Key`). Check your course's rules on AI first.

## Get started
1. Install **ICE Nattee Grader** from Extensions (`Ctrl+Shift+X`). For Cursor, Windsurf and VSCodium it's on
   [Open VSX](https://open-vsx.org/extension/potosua7/nattee-grader).
2. Click the **ICE Nattee Grader** icon in the activity bar and **Sign in**.
3. Click the new-file button on a problem. It makes `05_List/05_List_15.py` (for example) and opens the statement.
   Any file named after a problem code is linked to it.
4. Click ▶ or save the file to run the tests.

Needs VS Code 1.90+ and Python 3 (Thonny's Python works), or `g++`/`gcc` for C/C++.

## Good to know
- The grader shows only the first 2 KB of each test. A test with a longer input shows as SKIP: submit to check it.
- Your password and Gemini key are kept in VS Code's secret storage, and your sign-in is only sent to the grader.
- On Gemini's free tier Google may use what you send to improve its products. Nothing is sent until you ask.
- Settings: search `nattee` in Settings (Python path, compiler, time limit, run on save, ...).

## Development
```
cd extension
node --test
python ../tools/build_vsix.py
```
Each release's `.vsix` is on [Releases](https://github.com/PoTOsuA7/ICE-grader-vscode/releases)
(`code --install-extension nattee-grader.vsix`).

## License
MIT. Bundles pdf.js (Apache-2.0), see `THIRD_PARTY_NOTICES.md`.

Unofficial student tool. It only reads what your own grader account can see and keeps it on your computer.
Check your course's rules before using it.
