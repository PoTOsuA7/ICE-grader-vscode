"""The grader client against a fake grader on this computer (never the real one), and Core's saved copies."""
import email.parser
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from thonnycontrib.ice_grader.client import GraderClient, GraderError, SessionExpired
from thonnycontrib.ice_grader.core import Core, NotSignedIn
from thonnycontrib.ice_grader.passwords import MemorySecrets
from test_pages import FORM, field, page, pane, row, tile

LOGIN_PAGE = '<form action="/login/login"><input name="authenticity_token" value="t&amp;1"><input name="password"></form>'
LIST = "<table>%s%s</table>" % (row(10, "05_List_15", "inprogress", "40.0", "500"), row(11, "06_Func_21", "untried", "0", None))


class FakeGrader(BaseHTTPRequestHandler):
    log = []  # (method, path, cookie header, body fields)
    submitted_id = "777"

    def log_message(self, *args):
        pass

    def _send(self, status=200, body=b"", headers=()):
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text):
        self._send(200, text.encode("utf-8"), [("Content-Type", "text/html; charset=utf-8")])

    def _signed_in(self):
        return "_session=abc" in (self.headers.get("Cookie") or "")

    def do_GET(self):
        self.log.append(("GET", self.path, self.headers.get("Cookie"), None))
        if self.path == "/":
            return self._html(LOGIN_PAGE)
        if self.path == "/elsewhere":
            return self._send(302, headers=[("Location", self.server.other + "/steal")])
        if self.path == "/steal":
            return self._html("nothing")
        if not self._signed_in():
            return self._send(302, headers=[("Location", "/")])
        if self.path == "/main/list":
            return self._html(LIST)
        if self.path == "/problems/10/download/statement":
            return self._send(200, b"%PDF-1.4 fake", [("Content-Type", "application/pdf"),
                                                      ("Content-Disposition", 'attachment; filename="05_List_15.PDF"')])
        if self.path == "/testcases/show_problem/10":
            return self._html(page(pane(1, ("4 Bytes", "2 3\n"), ("2 Bytes", "5\n"))))
        if self.path == "/submissions/direct_edit_problem/10":
            return self._html(FORM)
        if self.path == "/submissions/777":
            return self._html(field("Points", "50/100") + field("Result", tile(1, 2, "Correct", "P") + tile(2, 2, "Wrong answer", "-"))
                              + field("Grading Task Status", "done"))
        return self._send(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        ctype = self.headers.get("Content-Type") or ""
        if ctype.startswith("multipart/form-data"):
            msg = email.parser.BytesParser().parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
            fields = {p.get_param("name", header="content-disposition"): p.get_payload(decode=True).decode("utf-8")
                      for p in msg.get_payload()}
        else:
            fields = dict(urllib.parse.parse_qsl(body.decode("utf-8")))
        self.log.append(("POST", self.path, self.headers.get("Cookie"), fields))
        if self.path == "/login/login":
            if fields.get("password") != "pw":
                return self._html("Wrong password" + LOGIN_PAGE)
            return self._send(302, headers=[("Set-Cookie", "_session=abc; path=/; HttpOnly"), ("Location", "/main/list")])
        if self.path == "/main/submit" and self._signed_in():
            return self._send(302, headers=[("Location", "/submissions/" + self.submitted_id)])
        return self._send(404)


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGrader)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Client(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.other = serve(), serve()
        cls.server.other = "http://127.0.0.1:%d" % cls.other.server_port
        cls.root = "http://127.0.0.1:%d/" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        for s in (cls.server, cls.other):
            s.shutdown()
            s.server_close()

    def setUp(self):
        FakeGrader.log.clear()

    def signed_in(self):
        c = GraderClient(self.root)
        c.login("student1", "pw")
        return c

    def test_sign_in_then_read_problems_statement_and_tests(self):
        c = self.signed_in()
        login = [e for e in FakeGrader.log if e[0] == "POST"][0][3]
        self.assertEqual((login["login"], login["password"], login["authenticity_token"]), ("student1", "pw", "t&1"))
        self.assertEqual([p["code"] for p in c.list_problems()], ["05_List_15", "06_Func_21"])
        self.assertEqual(c.fetch_statement("10"), (b"%PDF-1.4 fake", ".pdf"))
        self.assertEqual(c.fetch_testcases("10"), [{"input": "2 3\n", "output": "5\n"}])

    def test_wrong_password_and_expired_session(self):
        with self.assertRaisesRegex(GraderError, "Wrong ID or password"):
            GraderClient(self.root).login("x", "nope")
        with self.assertRaises(SessionExpired):
            GraderClient(self.root, {"_session": "old"}).list_problems()

    def test_the_session_cookie_never_goes_to_another_site(self):
        c = self.signed_in()
        c._request(self.root + "elsewhere")
        steal = [e for e in FakeGrader.log if e[1] == "/steal"]
        self.assertEqual(len(steal), 1)
        self.assertIsNone(steal[0][2])

    def test_submit_sends_the_form_the_grader_expects_and_waits_for_the_grade(self):
        c = self.signed_in()
        sub = c.submit("10", "print(1)\n")
        self.assertEqual(sub, {"id": "777", "language": "Python"})
        posted = [e[3] for e in FakeGrader.log if e[1] == "/main/submit"]
        self.assertEqual(posted, [{"authenticity_token": "tok+en", "editor_text": "print(1)\n",
                                   "submission[problem_id]": "892", "language_id": "6", "commit": "Submit"}])
        grade = c.wait_for_grade("777")
        self.assertEqual((grade["points"], grade["max"], grade["done"], grade["timed_out"]), (50, 100, True, False))


class FakeClient:
    """Stands in for GraderClient in Core's tests."""
    calls = []
    down = False  # the grader site is unreachable
    expired = False  # the next call finds the session expired

    def __init__(self, root, cookies=None):
        self.cookies = dict(cookies or {})

    def _call(self, name):
        FakeClient.calls.append(name)
        if FakeClient.down:
            raise OSError("site down")
        if FakeClient.expired:
            FakeClient.expired = False
            raise SessionExpired("expired")

    def login(self, uid, password):
        self._call("login")
        if password != "pw":
            raise GraderError("Wrong ID or password")
        self.cookies = {"_session": "abc"}

    def list_problems(self):
        self._call("list")
        return [{"id": "10", "code": "05_List_15", "name": "x", "has_testcases": True, "status": "untried", "score": 0,
                 "last_submission_id": "500"},
                {"id": "11", "code": "Exam1-2024_Q1A_student", "name": "y", "has_testcases": False, "status": "untried",
                 "score": 0, "last_submission_id": None}]

    def fetch_statement(self, pid):
        self._call("statement")
        return b"%PDF", ".pdf"

    def fetch_testcases(self, pid):
        self._call("tests")
        return [{"input": "1\n", "output": "1\n"}]

    def fetch_submission_source(self, sid):
        self._call("source")
        return {"source": "print(1)\n", "language": "Python"}


class Saved(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        FakeClient.calls, FakeClient.down, FakeClient.expired = [], False, False

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def core(self, secrets=None):
        # never the real password store: a test must not write to the computer's Credential Manager / Keychain
        return Core(self.dir, "https://grader.test/", FakeClient, secrets if secrets is not None else MemorySecrets())

    def test_sign_in_is_remembered_without_the_password(self):
        c = self.core()
        self.assertFalse(c.signed_in)
        with self.assertRaises(NotSignedIn):
            c.refresh_problems()
        c.sign_in("student1", "pw")
        with open(os.path.join(self.dir, "grader.test", "session.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved, {"uid": "student1", "cookies": {"_session": "abc"}})
        again = self.core()
        self.assertTrue(again.signed_in)
        self.assertEqual(again.client.cookies, {"_session": "abc"})
        self.assertEqual([p["code"] for p in again.problems], ["05_List_15", "Exam1-2024_Q1A_student"])
        again.sign_out()
        self.assertFalse(self.core().signed_in)

    def test_works_while_the_site_is_down_once_saved(self):
        c = self.core()
        c.sign_in("u", "pw")
        p = c.problems[0]
        c.download_all()
        FakeClient.down = True
        self.assertEqual(c.tests(p), [{"input": "1\n", "output": "1\n"}])
        with open(c.statement_path(p), "rb") as f:
            self.assertEqual(f.read(), b"%PDF")
        self.assertEqual(c.tests(c.problems[1]), [])  # no tests on the grader: nothing to fetch
        with self.assertRaises(OSError):
            c.refresh_problems()
        self.assertEqual(len(self.core().problems), 2)

    def test_an_expired_session_signs_in_again_with_the_remembered_password(self):
        store = MemorySecrets()
        c = self.core(store)
        c.sign_in("u", "pw")
        self.assertTrue(c.remembered)
        self.assertEqual(store.values, {"grader:grader.test:u": "pw"})
        FakeClient.calls.clear()
        FakeClient.expired = True
        c.refresh_problems()
        self.assertEqual(FakeClient.calls, ["list", "login", "list"])
        restarted = self.core(store)  # Thonny restarted: the password comes from the password store
        FakeClient.calls.clear()
        FakeClient.expired = True
        restarted.refresh_problems()
        self.assertEqual(FakeClient.calls, ["list", "login", "list"])
        restarted.sign_out()
        self.assertEqual(store.values, {})
        self.assertFalse(self.core(store).signed_in)

    def test_without_a_password_store_an_expired_session_means_signing_in_again(self):
        class NoStore(MemorySecrets):
            def set(self, name, value):
                return False
        c = self.core(NoStore())
        c.sign_in("u", "pw")
        self.assertFalse(c.remembered)
        restarted = self.core(NoStore())
        FakeClient.expired = True
        with self.assertRaises(SessionExpired):
            restarted.refresh_problems()
        self.assertFalse(restarted.signed_in)

    def test_a_password_changed_on_the_grader_signs_you_out(self):
        store = MemorySecrets()
        self.core(store).sign_in("u", "pw")
        store.values["grader:grader.test:u"] = "old"
        restarted = self.core(store)
        FakeClient.expired = True
        with self.assertRaisesRegex(SessionExpired, "no longer works"):
            restarted.refresh_problems()
        self.assertFalse(restarted.signed_in)

    def test_any_file_can_be_linked_to_a_problem(self):
        c = self.core()
        c.sign_in("u", "pw")
        mine = os.path.join(self.dir, "homework", "my answer.py")
        self.assertIsNone(c.problem_for_file(mine))
        c.link(mine, c.problems[1])
        self.assertEqual(c.problem_for_file(mine)["id"], "11")
        self.assertEqual(self.core().problem_for_file(mine)["id"], "11")  # remembered
        c.link(os.path.join(self.dir, "05_List_15.py"), c.problems[1])  # a link wins over the name
        self.assertEqual(c.problem_for_file(os.path.join(self.dir, "05_List_15.py"))["id"], "11")

    def test_the_copied_pdf_is_named_after_the_problem(self):
        c = self.core()
        c.sign_in("u", "pw")
        first = c.clipboard_copy(c.problems[0])
        self.assertEqual(os.path.basename(first), "05_List_15.pdf")
        second = c.clipboard_copy(c.problems[1])
        self.assertEqual(os.path.basename(second), "Exam1-2024_Q1A_student.pdf")
        self.assertFalse(os.path.exists(first))  # only the latest copy is kept

    def test_files_belong_to_the_problem_they_are_named_after(self):
        c = self.core()
        c.sign_in("u", "pw")
        self.assertEqual(c.problem_for_file(os.path.join("x", "05_list_15.py"))["id"], "10")
        self.assertEqual(c.problem_for_file("Exam1-2024_Q1A_student.py")["id"], "11")
        self.assertIsNone(c.problem_for_file("homework.py"))

    def test_export_all(self):
        c = self.core()
        c.sign_in("u", "pw")
        out = os.path.join(self.dir, "out")
        saved, failed, stopped, solutions = c.export_all(out)
        self.assertEqual((saved, failed, stopped, solutions), (2, [], False, 1))
        self.assertEqual(sorted(os.listdir(os.path.join(out, "05_List"))), ["05_List_15.pdf", "05_List_15.py"])
        self.assertEqual(os.listdir(os.path.join(out, "Exam1")), ["Exam1-2024_Q1A_student.pdf"])


if __name__ == "__main__":
    unittest.main()
