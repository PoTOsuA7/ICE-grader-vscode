# Nattee Grader for VS Code

Everything from the NatteeGrader website inside VS Code, so you never alt-tab:

- **Sidebar** listing every problem, grouped by chapter (exams hidden by default).
- **Statement viewer**: click a problem to read its PDF beside your code. Switching to a
  linked solution file re-opens its statement automatically.
- **Test cases** downloaded straight from the grader and cached locally.
- **Auto-link**: a file named after a problem code (e.g. `05_List_15.py`) links itself, no setup.
- **Run tests** (▶ in the editor title bar or status bar) for `.py`, `.cpp`, `.c` files,
  with PASS / FAIL / TLE / RE per case and expected-vs-actual output.
- Credentials are kept in VS Code's secret storage, not a temp file.

## Install (local)
Run `python tools/build_vsix.py` then `code --install-extension nattee-grader.vsix`, and reload VS Code
(needs VS Code 1.90+).

## Use
1. Open the **Nattee Grader** icon in the activity bar → **Sign in**.
2. Right-click a problem → **Create Solution File** (creates `<code>.py` in your workspace, links it, shows the statement).
   Or open any file and run **Nattee: Link Current File to Problem**.
3. Click ▶ to run the tests, or just save the file: tests run automatically on save (`nattee.runOnSave`).

Settings (`nattee.*`): `rootUrl`, `hideExams`, `defaultExtension`, `pythonPath`, `cppCompiler`, `cCompiler`, `timeLimitSeconds`.

## Layout
- `extension/` — the VS Code extension (plain JS, no build step). `lib/client.js` talks to the grader,
  `lib/runner.js` runs solutions, `lib/statement.js` is the PDF viewer.
- `tools/build_vsix.py` — packages the extension into a `.vsix`.

## License
MIT. Bundles pdf.js (Apache-2.0), see `THIRD_PARTY_NOTICES.md`.

This is an unofficial student tool. It only reads what your own grader account can already see, and
stores it on your machine. Check your course's rules before using it.
