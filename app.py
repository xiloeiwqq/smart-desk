"""Локальный сервер экспоната «Умная доска».

Цепочка данных намеренно разделена на этапы:
перо -> OCR-кандидат -> ручное подтверждение -> безопасный AST -> SymPy -> точки.
Пользовательский текст никогда не передаётся в eval, sympify или parse_expr.
"""

from __future__ import annotations

import argparse
import ast
import base64
import binascii
import json
import math
import os
import re
import socket
import struct
import sys
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import sympy as sp


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("SMART_BOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("SMART_BOARD_PORT", "8018"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5vl:3b")
OLLAMA_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "120"))
OLLAMA_KEEP_ALIVE = os.environ.get("OLLAMA_KEEP_ALIVE", "30m")

MAX_BODY_BYTES = 1_500_000
MAX_PNG_BYTES = 1_048_576
MAX_FORMULA_LENGTH = 120
X_MIN, X_MAX, POINT_COUNT = -10.0, 10.0, 401
COEFFICIENT_MIN, COEFFICIENT_MAX = -10.0, 10.0
PLOT_ABS_LIMIT = 1_000.0

SYMBOLS = {name: sp.Symbol(name, real=True) for name in ("x", "a", "b", "c")}
TEMPLATES = {
    "linear": "a*x+b",
    "quadratic": "a*x**2+b*x+c",
    "inverse": "a/(x-b)+c",
}

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


class BoardError(ValueError):
    """Ожидаемая ошибка ввода или внешнего сервиса."""

    def __init__(self, code: str, message: str, status: int = 400, detail: str | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class ParsedFormula:
    source: str
    expression: sp.Expr
    parameters: tuple[str, ...]


def normalize_formula(text: str) -> str:
    """Приводит безопасные типографские варианты записи к синтаксису Python."""
    if not isinstance(text, str):
        raise BoardError("FORMULA_TYPE", "Формула должна быть строкой.")

    value = text.strip()
    if not 1 <= len(value) <= MAX_FORMULA_LENGTH:
        raise BoardError(
            "FORMULA_LENGTH",
            f"Введите формулу длиной от 1 до {MAX_FORMULA_LENGTH} символов.",
        )

    # Частые символы, которые возвращает OCR или экранная клавиатура.
    value = (
        value.replace("−", "-")
        .replace("–", "-")
        .replace("×", "*")
        .replace("·", "*")
        .replace("÷", "/")
        .replace("²", "**2")
        .replace("³", "**3")
        .replace("^", "**")
    )

    # Посетителю разрешено написать привычное y = ... или f(x) = ... .
    if "=" in value:
        if value.count("=") != 1:
            raise BoardError("FORMULA_EQUALS", "Используйте не более одного знака равенства.")
        left, value = (part.strip() for part in value.split("=", 1))
        if left.replace(" ", "").lower() not in {"y", "f(x)"}:
            raise BoardError("FORMULA_LEFT_SIDE", "Слева от равенства допустимо только y или f(x).")

    value = re.sub(r"\s+", "", value)
    if not value:
        raise BoardError("FORMULA_EMPTY", "После знака равенства должна быть формула.")
    if len(value) > MAX_FORMULA_LENGTH:
        raise BoardError("FORMULA_LENGTH", "Формула слишком длинная.")
    return value


def parse_formula(text: str) -> ParsedFormula:
    """Разбирает выражение через строгий белый список узлов Python AST."""
    source = normalize_formula(text)
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise BoardError(
            "FORMULA_SYNTAX",
            "Не удалось прочитать формулу. Используйте x, a, b, c и знаки + − × ÷, ^.",
        ) from exc

    if len(list(ast.walk(tree))) > 64:
        raise BoardError("FORMULA_COMPLEX", "Формула слишком сложная для этого экспоната.")

    def build(node: ast.AST) -> sp.Expr:
        if isinstance(node, ast.Expression):
            return build(node.body)
        if isinstance(node, ast.Name) and node.id in SYMBOLS:
            return SYMBOLS[node.id]
        if (
            isinstance(node, ast.Constant)
            and type(node.value) in (int, float)
            and math.isfinite(node.value)
            and abs(node.value) <= 10_000
        ):
            return sp.Rational(str(node.value))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            operand = build(node.operand)
            return -operand if isinstance(node.op, ast.USub) else operand
        if isinstance(node, ast.BinOp):
            left, right = build(node.left), build(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.Pow) and right.is_Integer and -2 <= int(right) <= 4:
                return left**right
        raise BoardError(
            "FORMULA_FORBIDDEN",
            "Допустимы только x, a, b, c, числа, + − × ÷ и целые степени от −2 до 4.",
        )

    expression = build(tree)
    if sp.count_ops(expression) > 24:
        raise BoardError("FORMULA_OPERATIONS", "В формуле слишком много операций.")

    parameters = tuple(name for name in ("a", "b", "c") if SYMBOLS[name] in expression.free_symbols)
    return ParsedFormula(source=source, expression=expression, parameters=parameters)


def _coefficient_values(payload: dict[str, Any]) -> dict[sp.Symbol, float]:
    raw = payload.get("coefficients", {})
    if not isinstance(raw, dict):
        raise BoardError("COEFFICIENTS_TYPE", "Коэффициенты должны быть объектом.")

    values: dict[sp.Symbol, float] = {}
    for name in ("a", "b", "c"):
        default = 1 if name == "a" else 0
        try:
            value = float(raw.get(name, default))
        except (TypeError, ValueError) as exc:
            raise BoardError("COEFFICIENT_INVALID", f"Коэффициент {name} должен быть числом.") from exc
        if not math.isfinite(value) or not COEFFICIENT_MIN <= value <= COEFFICIENT_MAX:
            raise BoardError(
                "COEFFICIENT_RANGE",
                f"Коэффициент {name} должен быть от {COEFFICIENT_MIN:g} до {COEFFICIENT_MAX:g}.",
            )
        values[SYMBOLS[name]] = value
    return values


def graph(payload: dict[str, Any]) -> dict[str, Any]:
    """Проверяет подтверждение и возвращает равномерный ряд точек графика."""
    if not isinstance(payload, dict):
        raise BoardError("PAYLOAD_TYPE", "Ожидался JSON-объект.")
    if payload.get("confirmed") is not True:
        raise BoardError("CONFIRMATION_REQUIRED", "Сначала проверьте и подтвердите формулу.")

    parsed = parse_formula(payload.get("formula", ""))
    values = _coefficient_values(payload)
    expression = parsed.expression.subs(values)
    fn = sp.lambdify(SYMBOLS["x"], expression, modules="math")

    points: list[list[float | None]] = []
    domain_gaps = 0
    finite_values: list[float] = []
    step = (X_MAX - X_MIN) / (POINT_COUNT - 1)

    for index in range(POINT_COUNT):
        x_value = round(X_MIN + index * step, 12)
        y_value: float | None
        try:
            candidate = float(fn(x_value))
            y_value = candidate if math.isfinite(candidate) and abs(candidate) <= PLOT_ABS_LIMIT else None
        except (ValueError, TypeError, ZeroDivisionError, OverflowError):
            y_value = None
        if y_value is None:
            domain_gaps += 1
        else:
            finite_values.append(y_value)
        points.append([x_value, y_value])

    return {
        "request_id": payload.get("request_id"),
        "formula": parsed.source,
        "parameters": list(parsed.parameters),
        "points": points,
        "domain_gaps": domain_gaps,
        "point_count": POINT_COUNT,
        "range": {"x": [X_MIN, X_MAX], "y": [-10, 10]},
        "finite_y": [min(finite_values), max(finite_values)] if finite_values else None,
    }


def _validate_png(encoded: Any) -> bytes:
    if not isinstance(encoded, str) or not encoded:
        raise BoardError("IMAGE_REQUIRED", "Сначала напишите формулу на доске.")
    if len(encoded) > 1_400_000:
        raise BoardError("IMAGE_TOO_LARGE", "Изображение доски превышает 1 МиБ.")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BoardError("IMAGE_BASE64", "Некорректные данные изображения.") from exc
    if len(image) > MAX_PNG_BYTES:
        raise BoardError("IMAGE_TOO_LARGE", "Изображение доски превышает 1 МиБ.")
    if len(image) < 24 or not image.startswith(b"\x89PNG\r\n\x1a\n") or image[12:16] != b"IHDR":
        raise BoardError("IMAGE_FORMAT", "Для распознавания требуется PNG.")
    width, height = struct.unpack(">II", image[16:24])
    if not width or not height or width > 4096 or height > 4096 or width * height > 6_000_000:
        raise BoardError("IMAGE_DIMENSIONS", "Недопустимый размер изображения.")
    return image


def recognize(payload: dict[str, Any]) -> dict[str, Any]:
    """Отправляет реальный PNG локальной vision-модели Ollama."""
    if not isinstance(payload, dict):
        raise BoardError("PAYLOAD_TYPE", "Ожидался JSON-объект.")
    _validate_png(payload.get("image_base64", ""))
    encoded = payload["image_base64"]

    message = {
        "model": MODEL,
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "images": [encoded],
        "format": "json",
        "options": {"temperature": 0, "num_predict": 100},
        "prompt": (
            "Read exactly one handwritten mathematical function from the image. "
            "Return JSON only: {\"formula\":\"...\"}. Use Python expression syntax: "
            "explicit *, ** for powers, and only variables x,a,b,c. You may omit y=. "
            "Do not solve, explain or invent content."
        ),
    }
    request = Request(
        f"{OLLAMA_URL}/api/generate",
        json.dumps(message).encode("utf-8"),
        {"Content-Type": "application/json"},
        method="POST",
    )

    started = time.perf_counter()
    try:
        with urlopen(request, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            answer = json.load(response)
    except HTTPError as exc:
        detail = exc.read(512).decode("utf-8", errors="replace")
        raise BoardError(
            "OLLAMA_ERROR",
            "Локальная модель вернула ошибку.",
            status=HTTPStatus.BAD_GATEWAY,
            detail=detail,
        ) from exc
    except (URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
        raise BoardError(
            "OLLAMA_UNAVAILABLE",
            f"Ollama недоступен. Запустите сервис и загрузите модель {MODEL}.",
            status=HTTPStatus.SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc

    try:
        model_payload = json.loads(answer["response"])
        candidate = model_payload["formula"]
        parsed = parse_formula(candidate)
    except (KeyError, TypeError, json.JSONDecodeError, BoardError) as exc:
        if isinstance(exc, BoardError):
            detail = str(exc)
        else:
            detail = "Ответ модели не содержит строку formula."
        raise BoardError(
            "OCR_RESPONSE_INVALID",
            "Модель не смогла вернуть допустимую формулу. Напишите крупнее или исправьте вручную.",
            status=HTTPStatus.UNPROCESSABLE_ENTITY,
            detail=detail,
        ) from exc

    return {
        "request_id": payload.get("request_id"),
        "candidate": parsed.source,
        "parameters": list(parsed.parameters),
        "model": MODEL,
        "confirmed": False,
        "latency_ms": round((time.perf_counter() - started) * 1000),
    }


def ollama_status(timeout: float = 2.0) -> dict[str, Any]:
    """Проверяет Ollama без запуска модели и сообщает фактический digest."""
    result: dict[str, Any] = {
        "available": False,
        "model": MODEL,
        "model_ready": False,
        "model_digest": None,
    }
    try:
        with urlopen(f"{OLLAMA_URL}/api/tags", timeout=timeout) as response:
            models = json.load(response).get("models", [])
        result["available"] = True
        selected = next((item for item in models if item.get("name") == MODEL), None)
        if selected:
            result["model_ready"] = True
            result["model_digest"] = selected.get("digest")
            result["model_size"] = selected.get("size")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        result["error"] = str(exc)
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "SmartBoard/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        if os.environ.get("SMART_BOARD_QUIET") != "1":
            super().log_message(format_string, *args)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
        )

    def send_bytes(self, status: int, data: bytes, content_type: str, cache: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600" if cache else "no-store")
        self._security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_bytes(status, encoded, "application/json; charset=utf-8")

    def send_error_payload(self, error: BoardError) -> None:
        payload = {"error": str(error), "code": error.code}
        if error.detail and os.environ.get("SMART_BOARD_DEBUG") == "1":
            payload["detail"] = error.detail
        self.send_json(error.status, payload)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route in STATIC_FILES:
            filename, content_type = STATIC_FILES[route]
            path = ROOT / filename
            if path.is_file():
                self.send_bytes(HTTPStatus.OK, path.read_bytes(), content_type, cache=route != "/")
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Файл интерфейса не найден.", "code": "NOT_FOUND"})
            return
        if route == "/api/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "service": "smart-board",
                    "version": "1.0",
                    "sympy": sp.__version__,
                    "model": MODEL,
                    "templates": TEMPLATES,
                },
            )
            return
        if route == "/api/ocr-status":
            self.send_json(HTTPStatus.OK, ollama_status())
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Маршрут не найден.", "code": "NOT_FOUND"})

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise BoardError("CONTENT_LENGTH", "Некорректная длина запроса.") from exc
        if not 0 < length <= MAX_BODY_BYTES:
            raise BoardError("REQUEST_SIZE", "Запрос пуст или превышает допустимый размер.", 413)
        if self.headers.get_content_type() != "application/json":
            raise BoardError("CONTENT_TYPE", "Требуется Content-Type: application/json.", 415)
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BoardError("JSON_INVALID", "Некорректный JSON.") from exc
        if not isinstance(value, dict):
            raise BoardError("PAYLOAD_TYPE", "Ожидался JSON-объект.")
        return value

    def do_POST(self) -> None:
        route = self.path.split("?", 1)[0]
        try:
            body = self._read_json()
            if route in {"/api/plot", "/plot"}:
                self.send_json(HTTPStatus.OK, graph(body))
                return
            if route in {"/api/recognize", "/recognize"}:
                self.send_json(HTTPStatus.OK, recognize(body))
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Маршрут не найден.", "code": "NOT_FOUND"})
        except BoardError as exc:
            self.send_error_payload(exc)
        except Exception as exc:  # Не раскрываем посетителю внутренние детали.
            if os.environ.get("SMART_BOARD_DEBUG") == "1":
                raise
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Внутренняя ошибка стенда.", "code": "INTERNAL_ERROR"},
            )


class SmartBoardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def self_test() -> None:
    dangerous = [
        "__import__('os').system('id')",
        "x.__class__",
        "[x for x in [1]]",
        "x**10000",
        "sin(x)",
        "lambda: x",
        "open('file')",
    ]
    for formula in dangerous:
        try:
            parse_formula(formula)
        except BoardError:
            pass
        else:
            raise AssertionError(f"unsafe input accepted: {formula}")

    assert normalize_formula(" y = a × x² + b × x + c ") == "a*x**2+b*x+c"
    expected_at_two = {"linear": 2.0, "quadratic": 4.0, "inverse": 0.5}
    for template, expected in expected_at_two.items():
        result = graph({"confirmed": True, "formula": TEMPLATES[template]})
        actual = next(y for x, y in result["points"] if x == 2)
        assert actual is not None and abs(actual - expected) < 1e-9

    inverse = graph({"confirmed": True, "formula": "1/x"})
    assert inverse["points"][200][1] is None and inverse["domain_gaps"] == 1
    shifted = graph(
        {
            "confirmed": True,
            "formula": "a*x+b",
            "coefficients": {"a": 2, "b": 3, "c": 0},
        }
    )
    assert shifted["points"][240][1] == 7
    try:
        graph({"confirmed": False, "formula": "x"})
    except BoardError as exc:
        assert exc.code == "CONFIRMATION_REQUIRED"
    else:
        raise AssertionError("confirmation bypassed")

    print("PASS: 3 шаблона, коэффициенты, разрыв области, подтверждение и безопасный AST")
    print("NOT TESTED: физическое перо и качество реальной OCR-модели")


def doctor() -> int:
    result = {
        "sympy": sp.__version__,
        "ollama_url": OLLAMA_URL,
        "ocr_timeout_seconds": OLLAMA_TIMEOUT_SECONDS,
        "ollama_keep_alive": OLLAMA_KEEP_ALIVE,
        **ollama_status(timeout=3),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["model_ready"] else 2


def main() -> int:
    parser = argparse.ArgumentParser(description="Локальный сервер экспоната «Умная доска»")
    parser.add_argument("--host", default=HOST, help=f"адрес сервера (по умолчанию {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"порт сервера (по умолчанию {PORT})")
    parser.add_argument("--self-test", action="store_true", help="проверить математику и границу ввода")
    parser.add_argument("--doctor", action="store_true", help="проверить Ollama и OCR-модель")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0
    if args.doctor:
        return doctor()

    server = SmartBoardServer((args.host, args.port), Handler)
    print(f"Умная доска: http://{args.host}:{args.port}")
    print(f"OCR: {OLLAMA_URL} · {MODEL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
