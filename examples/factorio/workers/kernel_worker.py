"""Persistent IPython worker for the Helix Factorio example.

Protocol frames use one JSON object per stdout line. Cell stdout/stderr are
captured into the execute result; protocol diagnostics belong on stderr.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import sys
import traceback
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

PROTOCOL_VERSION = "1"
MAX_OUTPUT_CHARS = 8_192
DENIED_NAMES = {
    "__import__",
    "breakpoint",
    "compile",
    "eval",
    "exec",
    "globals",
    "input",
    "locals",
    "open",
    "os",
    "pathlib",
    "socket",
    "subprocess",
    "sys",
}


def send(frame: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(frame, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def receive() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise EOFError("controller closed stdin")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("protocol frame must be an object")
    return value


def validate_cell(source: str) -> None:
    tree = ast.parse(source, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal)):
            raise ValueError(f"POLICY_VIOLATION: {type(node).__name__} is forbidden")
        if isinstance(node, ast.Name) and node.id in DENIED_NAMES:
            raise ValueError(f"POLICY_VIOLATION: name {node.id!r} is forbidden")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError("POLICY_VIOLATION: private attributes are forbidden")


@dataclass
class EffectResult:
    method: str
    observation: dict[str, Any]
    refs: dict[str, Any]
    metrics: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "observation": self.observation,
            "refs": self.refs,
            "metrics": self.metrics,
        }

    def get(self, key: str, default: Any = None) -> Any:
        """Provide the ordinary mapping access models expect from tool results."""
        return self.as_dict().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self.as_dict()[key]

    def __repr__(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, indent=2, default=str)


class FactorioBinding:
    def __init__(self) -> None:
        self._effect_count = 0
        self.last: EffectResult | None = None

    def begin_cell(self) -> None:
        self._effect_count = 0

    def _request(self, method: str, params: dict[str, Any]) -> EffectResult:
        if self._effect_count >= 1:
            raise RuntimeError("MULTIPLE_EFFECTS_IN_CELL: one reset or step per cell")
        self._effect_count += 1
        send(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": "effect_request",
                "method": method,
                "params": params,
            }
        )
        response = receive()
        if response.get("type") != "effect_response":
            raise RuntimeError("invalid effect response frame")
        if not response.get("ok"):
            error = response.get("error") or {}
            raise RuntimeError(
                f"{error.get('code', 'EFFECT_ERROR')}: "
                f"{error.get('message', 'environment effect failed')}"
            )
        result = response["result"]
        self.last = EffectResult(
            method=method,
            observation=result.get("observation", {}),
            refs=result.get("refs", {}),
            metrics=result.get("metrics", {}),
        )
        return self.last

    def reset(self) -> EffectResult:
        """Create the fixed FLE task episode and return a bounded observation."""
        return self._request("reset", {})

    def step(self, program: str) -> EffectResult:
        """Execute one FLE public-namespace Python action program."""
        if not isinstance(program, str):
            raise TypeError("factorio.step(program) requires a string")
        return self._request("step", {"program": program})

    def status(self) -> EffectResult | None:
        """Return the last confirmed bounded environment result."""
        return self.last


def namespace_inventory(shell: InteractiveShell) -> list[dict[str, Any]]:
    hidden = {"In", "Out", "exit", "get_ipython", "open", "quit"}
    inventory: list[dict[str, Any]] = []
    for name, value in sorted(shell.user_ns.items()):
        if name.startswith("_") or name in hidden:
            continue
        item: dict[str, Any] = {"name": name, "type": type(value).__name__}
        try:
            item["length"] = len(value)  # type: ignore[arg-type]
        except Exception:
            pass
        inventory.append(item)
    return inventory[:128]


def truncate(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_OUTPUT_CHARS:
        return value, False
    return value[:MAX_OUTPUT_CHARS], True


def main() -> None:
    shell = InteractiveShell.instance()
    factorio = FactorioBinding()
    revision = 0

    while True:
        try:
            frame = receive()
        except EOFError:
            return
        request_type = frame.get("type")
        if request_type == "close":
            send({"protocolVersion": PROTOCOL_VERSION, "type": "closed"})
            return
        if request_type != "execute":
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "type": "execute_result",
                    "ok": False,
                    "error": {"code": "BAD_REQUEST", "message": "expected execute"},
                }
            )
            continue

        source = frame.get("code")
        expected_revision = frame.get("expectedRevision")
        if not isinstance(source, str):
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "type": "execute_result",
                    "ok": False,
                    "error": {
                        "code": "BAD_REQUEST",
                        "message": "code must be a string",
                    },
                }
            )
            continue
        if expected_revision != revision:
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "type": "execute_result",
                    "ok": False,
                    "error": {
                        "code": "STALE_KERNEL_REVISION",
                        "message": f"expected {expected_revision}, current {revision}",
                    },
                }
            )
            continue

        factorio.begin_cell()
        shell.user_ns["factorio"] = factorio
        shell.user_ns["helix"] = SimpleNamespace(**(frame.get("bootstrap") or {}))
        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        error: dict[str, Any] | None = None
        try:
            validate_cell(source)
            with contextlib.redirect_stdout(
                captured_stdout
            ), contextlib.redirect_stderr(captured_stderr):
                result = shell.run_cell(source, store_history=True, silent=False)
            execution_error = result.error_in_exec or result.error_before_exec
            if execution_error is not None:
                error = {
                    "code": "CELL_EXECUTION_ERROR",
                    "type": type(execution_error).__name__,
                    "message": str(execution_error),
                }
        except Exception as exc:
            error = {
                "code": "CELL_POLICY_OR_EXECUTION_ERROR",
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(limit=4),
            }

        stdout, stdout_truncated = truncate(captured_stdout.getvalue())
        stderr, stderr_truncated = truncate(captured_stderr.getvalue())
        revision += 1
        send(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": "execute_result",
                "ok": error is None,
                "startRevision": revision - 1,
                "endRevision": revision,
                "stdout": stdout,
                "stderr": stderr,
                "stdoutTruncated": stdout_truncated,
                "stderrTruncated": stderr_truncated,
                "namespace": namespace_inventory(shell),
                "effectCount": factorio._effect_count,
                **({"error": error} if error else {}),
            }
        )


if __name__ == "__main__":
    main()
