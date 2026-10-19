"""Reading the grader's pages and comparing outputs (same cases as the VS Code extension's tests)."""
import unittest

from thonnycontrib.ice_grader.client import (parse_data_files, parse_problem_list, parse_submission_page,
                                             parse_submission_source, parse_submit_form, parse_testcase_page)
from thonnycontrib.ice_grader.diff import compared_outputs, first_difference, normalize, visible
from thonnycontrib.ice_grader.layout import chapter_of, safe_name, solution_path


def row(pid, code, status, score, sub):
    link = '<a data-turbo="false" href="/submissions/%s">%s</a>' % (sub, sub) if sub else "-"
    return """<tr>
<td class='text-end' data-order='1'><div>1</div></td>
<td><div class='d-flex align-items-center'><strong>
%s_&ZeroWidthSpace;Name &amp; Co
</strong></div>
<div class='text-muted font-monospace'>
%s
</div>
<a href="/problems/%s/download/statement">Read</a> <a class="link-flex" href="/testcases/show_problem/%s">Testcases</a>
</td>
<td data-order='%s' style='width: 12em; vertical-align: middle'><div class='progress'></div></td>
<td>%s</td>
<td>%s</td>
</tr>""" % (code, code, pid, pid, score, link, status)


def field(label, value):
    return "<div class='row mb-2'>\n<div class='col-4 text-end text-secondary'>\n%s\n</div>\n<div class='col'>\n%s\n</div>\n</div>" % (label, value)


def tile(n, total, label, letter):
    return '<span class="verdict-tile" title="Test %d of %d: %s">%s</span>' % (n, total, label, letter)


def tc_file(label, size, text):
    return """<div class='col-md-6'>
<div class='d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1'>
<h6 class='mb-0'>%s</h6>
<div class='d-flex align-items-center gap-2'>
<span class='text-secondary small'>%s</span>
</div>
</div>
<textarea class='form-control font-monospace small' readonly rows='20' spellcheck='false'>%s</textarea>
</div>""" % (label, size, text)


def pane(pid, inp, out):
    return "<div class='tab-pane' id='tc%s' role='tabpanel'>\n<div class='row g-3'>\n%s\n%s\n</div>\n</div>" % (
        pid, tc_file("Input", *inp), tc_file("Expected output", *out))


def page(*panes, data=""):
    return ("<span class='badge'>\n<span class='mi md-18'>content_cut</span>\nShowing the first 2 KB of each file\n</span>\n"
            "<div class='tab-content'>%s</div>%s" % ("\n".join(panes), data))


FORM = """<form action="/main/submit" method="post"><input type="hidden" name="authenticity_token" value="tok&#43;en" autocomplete="off" />
<input type="hidden" name="submission[problem_id]" id="submission_problem_id" value="892" autocomplete="off" />
<select id="language_id" name="language_id"><option value="6">Python</option><option value="2">C++</option></select></form>"""


class Pages(unittest.TestCase):
    def test_problem_list_reads_status_score_submission_and_cleans_names(self):
        html = "<table><tbody><!-- x -->%s%s%s</tbody></table>" % (
            row(10, "05_List_11", "solved", "100.0", "555"), row(11, "05_List_12", "inprogress", "40.0", "556"),
            row(12, "05_List_13", "untried", "0", None))
        problems = parse_problem_list(html)
        self.assertEqual([p["status"] for p in problems], ["solved", "inprogress", "untried"])
        self.assertEqual([p["score"] for p in problems], [100, 40, 0])
        self.assertEqual([p["last_submission_id"] for p in problems], ["555", "556", None])
        self.assertEqual(problems[0]["id"], "10")
        self.assertEqual(problems[0]["code"], "05_List_11")
        self.assertIn("Name & Co", problems[0]["name"])
        self.assertTrue(all(p["has_testcases"] for p in problems))

    def test_submission_page(self):
        html = (field("Points", "60.0/100") + field("Result", tile(1, 2, "Correct", "P") + tile(2, 2, "Wrong answer", "-"))
                + field("Runtime", "<span>0.014</span>\n<span class='x'>s</span>") + field("Grading Task Status", "done"))
        g = parse_submission_page(html)
        self.assertEqual((g["points"], g["max"], g["done"], g["readable"], g["runtime"]), (60, 100, True, True, "0.014 s"))
        self.assertEqual([(t["n"], t["label"]) for t in g["tests"]], [(1, "Correct"), (2, "Wrong answer")])
        still = parse_submission_page(field("Grading Task Status", "processing"))
        self.assertEqual((still["done"], still["status"]), (False, "processing"))
        self.assertFalse(parse_submission_page("<html>login</html>")["readable"])

    def test_submitted_code_is_read_exactly_with_its_language(self):
        html = ("<textarea data-editor-target='source' id='text_sourcecode' style='display:none'>if a &lt; b and s == &quot;x&quot;:\n"
                "    print(&#39;&amp;&#39;)\n</textarea>\n" + field("Language", "Python"))
        self.assertEqual(parse_submission_source(html), {"source": "if a < b and s == \"x\":\n    print('&')\n", "language": "Python"})
        self.assertTrue(parse_submission_source(html.replace("none'>", "none'>\n"))["source"].startswith("if a"))
        self.assertIsNone(parse_submission_source('<form action="/login/login"><input name="password"></form>'))

    def test_submit_form(self):
        f = parse_submit_form(FORM)
        self.assertEqual(f, {"token": "tok+en", "problem_id": "892",
                             "languages": [{"id": "6", "name": "Python"}, {"id": "2", "name": "C++"}]})

    def test_tests_from_the_page_decoding_entities(self):
        cases = parse_testcase_page(page(pane(1, ("3 Bytes", "toy"), ("5 Bytes", "toys\n")),
                                         pane(2, ("5 Bytes", "a &lt; b"), ("4 Bytes", "yes\n"))))
        self.assertEqual([(c["id"], c["input"], c["output"], c["input_cut"], c["output_cut"]) for c in cases],
                         [("1", "toy", "toys\n", False, False), ("2", "a < b", "yes\n", False, False)])

    def test_newline_after_textarea_dropped_only_when_the_size_proves_it_is_extra(self):
        [c] = parse_testcase_page(page(pane(1, ("1 Byte", "\n5"), ("2 Bytes", "\n\n"))))
        self.assertEqual((c["input"], c["output"]), ("5", "\n\n"))

    def test_a_file_bigger_than_shown_is_cut(self):
        [c] = parse_testcase_page(page(pane(1, ("50 KB", "x" * 2048), ("3 Bytes", "ok\n"))))
        self.assertEqual((c["input_cut"], c["output_cut"]), (True, False))

    def test_data_files_are_read_but_not_taken_as_a_test(self):
        data = "<div id='data-files'>%s</div>" % tc_file("data.txt", "6 Bytes", "1\n2\n3\n")
        html = page(pane(1, ("15 Bytes", "/data/data.txt\n"), ("2 Bytes", "6\n")), data=data)
        self.assertEqual(len(parse_testcase_page(html)), 1)
        self.assertEqual(parse_data_files(html), [{"name": "data.txt", "text": "1\n2\n3\n", "cut": False}])


class Compare(unittest.TestCase):
    def test_lenient_like_the_grader(self):
        self.assertEqual(normalize("a  \r\nb\t\n\n\n"), "a\nb")
        self.assertNotEqual(normalize("Hello  Python."), normalize("Hello Python."))

    def test_first_difference(self):
        d = first_difference("Hello  Python.\n", "Hello Python.\n")
        self.assertEqual((d["line"], d["kind"], d["index"], d["spacing_only"]), (1, "differs", 6, True))
        self.assertEqual(first_difference("1\n2\n", "1\n")["kind"], "missing")
        self.assertEqual(first_difference("1\n", "1\n2\n")["kind"], "extra")
        self.assertIsNone(first_difference("1\n", "1  \n\n"))
        self.assertEqual(visible("a b\t"), "a·b→")

    def test_cut_expected_output_checks_the_part_that_is_shown(self):
        tc = {"output": "1\n2\n34", "partial_output": True}
        self.assertEqual(compared_outputs(tc, "1\n2\n345\n6\n"), {"expected": "1\n2\n3", "actual": "1\n2\n3"})
        self.assertTrue(compared_outputs({"output": "x", "partial_output": True}, "y")["unchecked"])


class Layout(unittest.TestCase):
    def test_chapters_and_files(self):
        self.assertEqual(chapter_of("05_List_15"), "05_List")
        self.assertEqual(chapter_of("2025s1_Exam2_A1-1_Student"), "Exam2")
        self.assertEqual(chapter_of("Exam1-2024_Q1A_student"), "Exam1")
        self.assertEqual(chapter_of("Example_1"), "Example_1")
        self.assertEqual(safe_name(".."), "problem")
        self.assertEqual(safe_name("a/b c"), "a_b_c")
        self.assertTrue(solution_path("root", "05_List_15").replace("\\", "/").endswith("root/05_List/05_List_15.py"))


if __name__ == "__main__":
    unittest.main()
