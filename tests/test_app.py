import base64
import json
import os
import struct
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app


class FormulaTests(unittest.TestCase):
    def test_normalizes_museum_friendly_notation(self):
        self.assertEqual(
            app.normalize_formula(" y = a × x² + b × x + c "),
            "a*x**2+b*x+c",
        )
        self.assertEqual(app.normalize_formula("f(x) = 1 ÷ x"), "1/x")

    def test_parses_allowed_expression_without_eval(self):
        parsed = app.parse_formula("a/(x-b)+c")
        self.assertEqual(parsed.source, "a/(x-b)+c")
        self.assertEqual(parsed.parameters, ("a", "b", "c"))

    def test_rejects_code_and_unknown_math(self):
        forbidden = [
            "__import__('os')",
            "x.__class__",
            "sin(x)",
            "[x]",
            "{x: 1}",
            "x if a else b",
            "x**5",
            "other+x",
        ]
        for formula in forbidden:
            with self.subTest(formula=formula), self.assertRaises(app.BoardError):
                app.parse_formula(formula)

    def test_rejects_unsupported_left_side(self):
        with self.assertRaises(app.BoardError) as context:
            app.parse_formula("z = x + 1")
        self.assertEqual(context.exception.code, "FORMULA_LEFT_SIDE")


class GraphTests(unittest.TestCase):
    def test_requires_explicit_confirmation(self):
        with self.assertRaises(app.BoardError) as context:
            app.graph({"formula": "x", "confirmed": False})
        self.assertEqual(context.exception.code, "CONFIRMATION_REQUIRED")

    def test_three_templates_and_coefficients(self):
        cases = [
            ("a*x+b", {"a": 2, "b": 3}, 7.0),
            ("a*x**2+b*x+c", {"a": 1, "b": 0, "c": 0}, 4.0),
            ("a/(x-b)+c", {"a": 1, "b": 0, "c": 0}, 0.5),
        ]
        for formula, coefficients, expected in cases:
            with self.subTest(formula=formula):
                result = app.graph(
                    {
                        "formula": formula,
                        "confirmed": True,
                        "coefficients": coefficients,
                    }
                )
                self.assertEqual(result["point_count"], 401)
                at_two = next(y for x, y in result["points"] if x == 2)
                self.assertAlmostEqual(at_two, expected)

    def test_inverse_contains_domain_gap(self):
        result = app.graph({"formula": "1/x", "confirmed": True})
        self.assertIsNone(result["points"][200][1])
        self.assertEqual(result["domain_gaps"], 1)

    def test_coefficient_range_is_enforced(self):
        with self.assertRaises(app.BoardError) as context:
            app.graph(
                {
                    "formula": "a*x",
                    "confirmed": True,
                    "coefficients": {"a": 10.5},
                }
            )
        self.assertEqual(context.exception.code, "COEFFICIENT_RANGE")


class ImageTests(unittest.TestCase):
    def test_png_header_and_dimensions_are_checked(self):
        png_stub = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", 1200, 420)
        encoded = base64.b64encode(png_stub).decode("ascii")
        self.assertEqual(app._validate_png(encoded), png_stub)

    def test_non_png_is_rejected(self):
        encoded = base64.b64encode(b"not a png").decode("ascii")
        with self.assertRaises(app.BoardError) as context:
            app._validate_png(encoded)
        self.assertEqual(context.exception.code, "IMAGE_FORMAT")


class HttpApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["SMART_BOARD_QUIET"] = "1"
        cls.server = app.SmartBoardServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request_json(self, path, payload=None):
        if payload is None:
            request = Request(self.base_url + path)
        else:
            request = Request(
                self.base_url + path,
                json.dumps(payload).encode("utf-8"),
                {"Content-Type": "application/json"},
                method="POST",
            )
        with urlopen(request, timeout=3) as response:
            return response.status, json.load(response), response.headers

    def test_health_and_security_headers(self):
        status, payload, headers = self.request_json("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])

    def test_plot_endpoint(self):
        status, payload, _ = self.request_json(
            "/api/plot",
            {"request_id": "test", "formula": "x**2", "confirmed": True},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["request_id"], "test")
        self.assertEqual(payload["points"][240], [2.0, 4.0])

    def test_plot_endpoint_rejects_unconfirmed_input(self):
        with self.assertRaises(HTTPError) as context:
            self.request_json("/api/plot", {"formula": "x", "confirmed": False})
        self.assertEqual(context.exception.code, 400)
        payload = json.loads(context.exception.read().decode("utf-8"))
        self.assertEqual(payload["code"], "CONFIRMATION_REQUIRED")


if __name__ == "__main__":
    unittest.main()
