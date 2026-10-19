"""AI explain (against a fake Gemini, never the real one), copying a file to the clipboard, drawing statements."""
import os
import shutil
import subprocess
import tempfile
import unittest

from thonnycontrib.ice_grader.ai import CODE_REMOVED, AIError, build_prompt, call_gemini, without_code
from thonnycontrib.ice_grader.clipboard import copy_command, copy_file
from thonnycontrib.ice_grader.statement import can_show_pdfs, render_pdf

FAILURE = {"n": 2, "verdict": "FAIL", "input": "3\n", "expected": "6\n", "actual": "5\n", "stderr": ""}


def answer(text):
    return 200, {"candidates": [{"content": {"parts": [{"text": "thinking...", "thought": True}, {"text": text}]}}]}


class FakeGemini:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.asked = []

    def __call__(self, key, model, body):
        self.asked.append((model, body))
        return self.replies.pop(0)


class Explain(unittest.TestCase):
    def test_the_prompt_has_the_code_the_failing_tests_and_where_they_differ(self):
        prompt = build_prompt("n = int(input())\nprint(n + 2)\n", [FAILURE] * 4, 4, {"code": "05_List_15", "name": "Sum"},
                              {"data.txt": "1 2"})
        self.assertIn("Problem: 05_List_15 - Sum", prompt)
        self.assertIn("print(n + 2)", prompt)
        self.assertIn("data.txt:", prompt)
        self.assertIn("Failing tests (3 of 4 shown):", prompt)
        self.assertIn("(First difference from expected: line 1, column 1)", prompt)

    def test_no_code_comes_back(self):
        self.assertEqual(without_code("Line 2 adds 2.\n```python\nprint(n * 2)\n```\nUse `n`.\n```\nx"),
                         "Line 2 adds 2.\n%s\n\nUse `n`.\n%s" % (CODE_REMOVED, CODE_REMOVED))

    def test_the_answer_without_its_thinking(self):
        gemini = FakeGemini(answer("Line 2 adds 2 instead of doubling."))
        r = call_gemini("key", ["m1", "m2"], "prompt", send=gemini, sleep=lambda s: None)
        self.assertEqual(r, {"text": "Line 2 adds 2 instead of doubling.", "model": "m1", "fallback": False})
        body = gemini.asked[0][1]
        self.assertIn("Do not write any code", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual(body["generationConfig"]["thinkingConfig"], {"thinkingLevel": "low"})

    def test_busy_gemini_is_retried_then_the_fallback_model_answers(self):
        busy = (503, {"error": {"message": "overloaded"}})
        gemini = FakeGemini(busy, busy, busy, answer("ok"))
        waits = []
        r = call_gemini("key", ["m1", "m2"], "prompt", send=gemini, sleep=waits.append)
        self.assertEqual((r["model"], r["fallback"]), ("m2", True))
        self.assertEqual([m for m, _ in gemini.asked], ["m1", "m1", "m1", "m2"])
        self.assertEqual(waits, [2, 5])

    def test_a_model_without_thinking_levels_is_asked_again_without(self):
        gemini = FakeGemini((400, {"error": {"message": "thinking level is not supported"}}), answer("ok"))
        call_gemini("key", ["m1"], "prompt", send=gemini, sleep=lambda s: None)
        self.assertNotIn("thinkingConfig", gemini.asked[1][1]["generationConfig"])

    def test_errors_say_what_to_do(self):
        for reply, words in [((400, {"error": {"message": "API key not valid"}}), "Invalid Gemini API key"),
                             ((429, {}), "limit"), ((200, {"promptFeedback": {"blockReason": "SAFETY"}}), "blocked"),
                             ((200, {"candidates": []}), "no explanation")]:
            with self.assertRaisesRegex(AIError, words):
                call_gemini("key", ["m1"], "prompt", send=FakeGemini(reply), sleep=lambda s: None)


class Clipboard(unittest.TestCase):
    def test_the_command_for_each_system(self):
        self.assertIn("Set-Clipboard -LiteralPath $env:ICE_FILE", copy_command("win32")[0][-1])
        self.assertIn("POSIX file", copy_command("darwin")[0][-1])
        self.assertIn("wl-copy", copy_command("linux", {"WAYLAND_DISPLAY": "wayland-0"})[0][-1])
        self.assertIn("xclip", copy_command("linux", {})[0][-1])

    def test_the_file_goes_in_the_environment_not_the_command(self):
        seen = []

        def run(cmd, env, **kw):
            seen.append((cmd, env["ICE_FILE"], env["ICE_URI"]))
            return subprocess.CompletedProcess(cmd, 0, None, b"")
        copy_file("/tmp/a b.pdf", "linux", run)
        cmd, path, uri = seen[0]
        self.assertTrue(path.endswith("a b.pdf") and uri.startswith("file:") and "a%20b.pdf" in uri)
        self.assertNotIn("a b.pdf", " ".join(cmd))

    def test_a_missing_tool_is_named(self):
        def run(cmd, **kw):
            raise FileNotFoundError(cmd[0])
        with self.assertRaisesRegex(OSError, "xclip is not installed"):
            copy_file("/tmp/x.pdf", "linux", run)


@unittest.skipUnless(can_show_pdfs(), "pypdfium2 is not installed")
class Statement(unittest.TestCase):
    def setUp(self):
        import pypdfium2 as pdfium
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "s.pdf")
        pdf = pdfium.PdfDocument.new()
        pdf.new_page(600, 800)
        pdf.new_page(600, 800)
        pdf.save(self.path)
        pdf.close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_every_page_is_drawn_to_the_width_asked_for_as_an_image_tk_can_read(self):
        pages = render_pdf(self.path, 300)
        self.assertEqual([(w, h) for w, h, _ in pages], [(300, 400), (300, 400)])
        data = pages[0][2]
        self.assertTrue(data.startswith(b"P6\n300 400\n255\n"))
        self.assertEqual(len(data), len(b"P6\n300 400\n255\n") + 300 * 400 * 3)
        self.assertEqual([(w, h) for w, h, _ in render_pdf(self.path, 300, zoom=2)], [(600, 800), (600, 800)])


if __name__ == "__main__":
    unittest.main()
