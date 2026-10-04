# ICE Nattee Grader for VS Code

Everything from the NatteeGrader website inside VS Code, so you never alt-tab:

- **Sidebar** listing every problem by chapter, with your progress from the grader: a tick for solved,
  a filled dot for in progress (with your best score), and `solved/total` per chapter. Exams are hidden by default.
- **Statement viewer**: click a problem to read its PDF beside your code. Switching to a linked solution file
  re-opens its statement automatically.
- **Auto-link**: a file named after a problem code (e.g. `05_List_15.py`) links itself, no setup.
- **Run tests** (▶ in the editor title bar or status bar, or automatically on save) for `.py`, `.cpp`, `.c` files,
  with PASS / FAIL / TLE / RE per case. For a wrong answer it points at the **first difference** (line and column)
  and makes spaces visible, so mistakes like `Hello  Python.` vs `Hello Python.` are obvious.
- **Run one test or your own input**: `Nattee: Run One Test or Custom Input` (type it, or use the clipboard).
- **Submit to the grader** without leaving VS Code (`Nattee: Submit to Grader`, the cloud button). It always asks
  for confirmation first, never submits on save, then shows the grader's points and per-test verdicts live.
- **Test Results** panel in the sidebar keeps results visible next to the statement.
- **Explain a failure with AI** (`Nattee: Explain Test Failure (AI)`, the ✨ button): sends your code and the
  failing tests (up to 3 at once) to Google's Gemini, using **your own Gemini API key**, and shows why it fails. It's told to explain
  the bug, not to hand back corrected code - the point is to help you fix it yourself, not to do the assignment
  for you. **Check your course's policy on AI assistance before using this.**
  - Get a free key at [aistudio.google.com](https://aistudio.google.com) → Get API key, then run
    `Nattee: Set Gemini API Key`. A Gemini app subscription (e.g. Google AI Pro) is separate from the API and
    isn't needed. School Google accounts may have AI Studio switched off; a personal Google account works.
  - On the free tier Google may use what you send to improve its products. Nothing is sent until you run
    the command. The model is set by `nattee.geminiModel` (default `gemini-3.8-flash`). If Google says it's
    overloaded, the extension retries twice and then asks `nattee.geminiFallbackModel` (default `gemini-3.5-flash`).
- Test cases are read from the grader's test case page and cached locally. The grader shows only the first 2 KB
  of each file: a test whose input is longer shows as SKIP (submit to check it), and a longer expected output is
  checked on the part that's shown. Credentials (grader and Gemini key) are
  kept in VS Code's secret storage, not a temp file.

## Install
In VS Code open Extensions (`Ctrl+Shift+X`), search **ICE Nattee Grader** and click Install. Needs VS Code 1.90+.
Cursor, Windsurf and VSCodium get it the same way, from [Open VSX](https://open-vsx.org/extension/potosua7/nattee-grader).

Or download `nattee-grader.vsix` from [Releases](https://github.com/PoTOsuA7/ICE-grader-vscode/releases) and run
`code --install-extension nattee-grader.vsix`. To build it yourself: `python tools/build_vsix.py`.

## Use
1. Open the **ICE Nattee Grader** icon in the activity bar → **Sign in**.
2. Right-click a problem → **Create Solution File**. It creates `<chapter>/<code>.py` in your workspace
   (e.g. `05_List/05_List_15.py`), links it and shows the statement. If a file with that name already exists
   anywhere in the workspace it opens that one instead. Set `nattee.organizeByChapter` to `false` to keep files flat.
   Or open any file and run **Nattee: Link Current File to Problem**.
3. Click ▶ to run the tests, or just save the file: tests run automatically on save (`nattee.runOnSave`).

Settings (`nattee.*`): `rootUrl`, `hideExams`, `defaultExtension`, `organizeByChapter`, `pythonPath`, `cppCompiler`, `cCompiler`, `timeLimitSeconds`, `runOnSave`, `geminiModel`, `geminiFallbackModel`.

## Layout
- `extension/` — the VS Code extension (plain JS, no build step). `lib/client.js` talks to the grader,
  `lib/runner.js` runs solutions, `lib/statement.js` is the PDF viewer.
- `tools/build_vsix.py` — packages the extension into a `.vsix`.

## Platforms
Written to be cross-platform (Windows, macOS, Linux). The automated tests run on all three in CI
(`.github/workflows/test.yml`), and it has been used by hand on Windows 11 only. Requires VS Code 1.90+ and
Python (or `g++`/`gcc` for C/C++ solutions). On macOS the Python command is usually `python3`; the extension
finds it automatically.

## Development
```
cd extension
node --test          # unit tests, no VS Code needed
python ../tools/build_vsix.py
python ../tools/publish_openvsx.py      # Open VSX upload; token from OVSX_PAT or ~/.ovsx_token
python ../tools/publish_marketplace.py  # VS Code Marketplace update; token from VSCE_PAT or ~/.vsce_token
```
Or upload by hand at marketplace.visualstudio.com/manage (Update → the `.vsix`).

## License
MIT. Bundles pdf.js (Apache-2.0), see `THIRD_PARTY_NOTICES.md`.

This is an unofficial student tool. It only reads what your own grader account can already see, and
stores it on your machine. Check your course's rules before using it.
