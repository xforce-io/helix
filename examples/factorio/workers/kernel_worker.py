"""Persistent IPython worker for the Helix Factorio example.

Protocol frames use one JSON object per stdout line. Cell stdout/stderr are
captured into the execute result; protocol diagnostics belong on stderr.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import resource
import sys
import traceback
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

PROTOCOL_VERSION = "2"
MAX_OUTPUT_CHARS = 8_192
DEFAULT_MEMORY_BYTES = 1_073_741_824
DEFAULT_CPU_SECONDS = 600
DENIED_NAMES = {
    "__import__",
    "breakpoint",
    "compile",
    "eval",
    "exec",
    "globals",
    "get_ipython",
    "help",
    "input",
    "locals",
    "open",
    "os",
    "pathlib",
    "socket",
    "subprocess",
    "sys",
    "vars",
    "exit",
    "quit",
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
        if isinstance(node, ast.Name) and (
            node.id in DENIED_NAMES or node.id.startswith("_")
        ):
            raise ValueError(f"POLICY_VIOLATION: name {node.id!r} is forbidden")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError("POLICY_VIOLATION: private attributes are forbidden")


class BoundedTextBuffer(io.TextIOBase):
    """A write sink that retains only the model-visible prefix."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit
        self.parts: list[str] = []
        self.length = 0
        self.truncated = False

    def write(self, value: str) -> int:
        text = str(value)
        remaining = max(0, self.limit - self.length)
        if remaining:
            retained = text[:remaining]
            self.parts.append(retained)
            self.length += len(retained)
        if len(text) > remaining:
            self.truncated = True
        return len(text)

    def getvalue(self) -> str:
        return "".join(self.parts)


def resource_limits_from_environment(env: dict[str, str] | os._Environ[str]) -> tuple[int, int]:
    def positive(name: str, default: int) -> int:
        raw = env.get(name, str(default))
        try:
            value = int(raw)
        except ValueError as exc:
            raise ValueError(f"{name} must be a positive integer") from exc
        if value <= 0:
            raise ValueError(f"{name} must be a positive integer")
        return value

    return (
        positive("HELIX_KERNEL_MEMORY_BYTES", DEFAULT_MEMORY_BYTES),
        positive("HELIX_KERNEL_CPU_SECONDS", DEFAULT_CPU_SECONDS),
    )


def apply_resource_limits() -> None:
    memory_bytes, cpu_seconds = resource_limits_from_environment(os.environ)
    # Darwin rejects lowering RLIMIT_AS for an already-loaded interpreter.
    # The parent process enforces RSS there (and redundantly on Linux).
    if sys.platform != "darwin":
        _, address_space_hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, address_space_hard))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))


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


@dataclass
class RecursiveModelResult:
    """Bounded recursive model call result (helix.recursive-model-result/v1)."""

    status: str
    text: str
    text_truncated: bool
    child_run_id: str | None
    usage: dict[str, Any] | None
    response_ref: dict[str, Any] | None
    error: dict[str, Any] | None
    reservation: dict[str, Any] | None
    request_digest: str | None = None
    attach_failed: bool = False

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "RecursiveModelResult":
        usage = payload.get("usage")
        reservation = payload.get("reservation")
        # Normalize camelCase wire → snake_case Python fields.
        if isinstance(reservation, dict):
            reservation = {
                "reserved_tokens": int(reservation.get("reservedTokens", 0) or 0),
                "declared_prompt_tokens": int(
                    reservation.get("declaredPromptTokens", 0) or 0
                ),
                "declared_completion_tokens": int(
                    reservation.get("declaredCompletionTokens", 0) or 0
                ),
                "requested_completion_tokens": reservation.get(
                    "requestedCompletionTokens"
                ),
                "actual_usage_tokens": int(
                    reservation.get("actualUsageTokens", 0) or 0
                ),
                "charged_tokens": int(reservation.get("chargedTokens", 0) or 0),
                "overflow_tokens": int(reservation.get("overflowTokens", 0) or 0),
            }
        if isinstance(usage, dict):
            usage = {
                "input_tokens": int(usage.get("inputTokens", 0) or 0),
                "output_tokens": int(usage.get("outputTokens", 0) or 0),
            }
        return cls(
            status=str(payload.get("status", "failed")),
            text=str(payload.get("text", "")),
            text_truncated=bool(payload.get("textTruncated", False)),
            child_run_id=payload.get("childRunId"),
            usage=usage,
            response_ref=payload.get("responseRef"),
            error=payload.get("error"),
            reservation=reservation,
            request_digest=payload.get("requestDigest"),
            attach_failed=bool(payload.get("attachFailed", False)),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "text": self.text,
            "text_truncated": self.text_truncated,
            "child_run_id": self.child_run_id,
            "usage": self.usage,
            "response_ref": self.response_ref,
            "error": self.error,
            "reservation": self.reservation,
            "request_digest": self.request_digest,
            "attach_failed": self.attach_failed,
        }

    def get(self, key: str, default: Any = None) -> Any:
        return self.as_dict().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self.as_dict()[key]

    def __repr__(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, indent=2, default=str)


class HelixModelsBinding:
    """Kernel-side recursive model binding (capability-gated)."""

    def __init__(self, effect_gate: "CellEffectGate") -> None:
        self._gate = effect_gate

    def call(
        self,
        instructions: str,
        input: Any = None,
        max_output_tokens: int | None = None,
    ) -> RecursiveModelResult:
        if not isinstance(instructions, str):
            raise TypeError("helix.models.call(instructions) requires a string")
        # Do NOT note_effect_attempt before Host response (B2 / I2).
        # Admission reject must leave the local UX gate free so a later
        # factorio.step in the same cell can still reach Host.
        params: dict[str, Any] = {"instructions": instructions}
        # IMP-2: omit input when None so Host treats it as missing/default empty.
        if input is not None:
            params["input"] = input
        if max_output_tokens is not None:
            params["maxOutputTokens"] = max_output_tokens
        send(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": "effect_request",
                "method": "models.call",
                "params": params,
            }
        )
        response = receive()
        if response.get("type") != "effect_response":
            raise RuntimeError("invalid effect response frame")
        # IMP-B: ok:false is ONLY for frame/protocol damage → Python exception.
        if not response.get("ok"):
            error = response.get("error") or {}
            raise RuntimeError(
                f"{error.get('code', 'EFFECT_ERROR')}: "
                f"{error.get('message', 'models.call failed')}"
            )
        result_payload = response.get("result") or {}
        if not isinstance(result_payload, dict):
            raise RuntimeError("models.call result must be an object")
        result = RecursiveModelResult.from_wire(result_payload)
        # Host occupies only after successful admission (succeeded/failed/cancelled
        # with commit, or rejected MULTIPLE after prior occupy). Pure admission
        # rejects (status=rejected, no child, reserved=0) must NOT note.
        if self._host_occupied_external_effect(result):
            self._gate.note_effect_attempt()
        return result

    @staticmethod
    def _host_occupied_external_effect(result: RecursiveModelResult) -> bool:
        status = result.status
        if status in ("succeeded", "failed", "cancelled"):
            return True
        if status != "rejected":
            return False
        # Rejected after a prior occupy (second effect) still means the cell slot
        # is taken; note so local factorio UX matches Host.
        error = result.error or {}
        code = error.get("code") if isinstance(error, dict) else None
        if code == "MULTIPLE_EFFECTS_IN_CELL":
            return True
        reservation = result.reservation or {}
        reserved = int(reservation.get("reserved_tokens", 0) or 0)
        if result.child_run_id or reserved > 0:
            return True
        return False



def _effect_rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Send effect_request and return result object (ok:true) or raise on protocol error."""
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
        raise RuntimeError(f"invalid effect response frame for {method}")
    if not response.get("ok"):
        error = response.get("error") or {}
        raise RuntimeError(
            f"{error.get('code', 'EFFECT_ERROR')}: "
            f"{error.get('message', method + ' failed')}"
        )
    result = response.get("result")
    if result is None:
        return {}
    if not isinstance(result, dict):
        raise RuntimeError(f"{method} result must be an object")
    return result


def _result_occupied_write_path(result: dict[str, Any]) -> bool:
    """Heuristic: Host occupied slot when result is not a pure admission reject."""
    error = result.get("error")
    if isinstance(error, dict) and error.get("code") == "MULTIPLE_EFFECTS_IN_CELL":
        return True
    status = result.get("status")
    if status == "rejected":
        return False
    # successful write paths return domain objects without status=rejected
    if "session_id" in result or "handle_id" in result or "msg_id" in result:
        return True
    if "committed_version" in result or "noop" in result:
        return True
    # non-null message consume
    if result.get("msg_seq") is not None and result.get("mailbox_id"):
        return True
    return False


class HelixSessionBinding:
    """Kernel-side session binding (capability + opaque tokens)."""

    def __init__(self, effect_gate: "CellEffectGate") -> None:
        self._gate = effect_gate
        self._creation_token: str | None = None
        self._session_token: str | None = None
        self._session_id: str | None = None
        self._actor: str = "none"
        self._handle_id: str | None = None

    def configure(
        self,
        *,
        creation_token: str | None = None,
        session_token: str | None = None,
        session_id: str | None = None,
        actor: str = "none",
        handle_id: str | None = None,
    ) -> None:
        self._creation_token = creation_token
        self._session_token = session_token
        self._session_id = session_id
        self._actor = actor
        self._handle_id = handle_id

    def create(self, capability_token: str, metadata: Any = None) -> dict[str, Any]:
        if not isinstance(capability_token, str) or not capability_token:
            raise TypeError("helix.session.create(capability_token) requires a non-empty string")
        params: dict[str, Any] = {"capabilityToken": capability_token}
        if metadata is not None:
            params["metadata"] = metadata
        result = _effect_rpc("session.create", params)
        token = result.get("session_capability_token")
        if isinstance(token, str) and token:
            self._session_token = token
        sid = result.get("session_id")
        if isinstance(sid, str) and sid:
            self._session_id = sid
            self._actor = "parent"
        if _result_occupied_write_path(result):
            self._gate.note_effect_attempt()
        return result

    def resume(
        self,
        session_id: str,
        capability_token: str,
        version: int | None = None,
    ) -> dict[str, Any]:
        if not isinstance(session_id, str) or not session_id:
            raise TypeError("session_id must be a non-empty string")
        if not isinstance(capability_token, str) or not capability_token:
            raise TypeError("capability_token must be a non-empty string")
        params: dict[str, Any] = {
            "sessionId": session_id,
            "capabilityToken": capability_token,
        }
        if version is not None:
            params["version"] = version
        result = _effect_rpc("session.resume", params)
        if result.get("session_id"):
            self._session_id = str(result["session_id"])
            self._session_token = capability_token
            self._actor = "parent"
        if _result_occupied_write_path(result):
            self._gate.note_effect_attempt()
        return result

    def checkpoint(self, note: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if note is not None:
            params["note"] = note
        result = _effect_rpc("session.checkpoint", params)
        if _result_occupied_write_path(result):
            self._gate.note_effect_attempt()
        return result

    def lookup(
        self,
        session_id: str | None = None,
        capability_token: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if session_id is not None:
            params["sessionId"] = session_id
        if capability_token is not None:
            params["capabilityToken"] = capability_token
        # lookup never occupies
        return _effect_rpc("session.lookup", params)


class HelixAgentsBinding:
    """Kernel-side async sub-agent binding."""

    def __init__(self, effect_gate: "CellEffectGate") -> None:
        self._gate = effect_gate

    def spawn(
        self,
        instructions: str,
        input: Any = None,
        max_output_tokens: int | None = None,
        mailbox: bool = True,
    ) -> dict[str, Any]:
        if not isinstance(instructions, str):
            raise TypeError("helix.agents.spawn(instructions) requires a string")
        params: dict[str, Any] = {"instructions": instructions, "mailbox": bool(mailbox)}
        if input is not None:
            params["input"] = input
        if max_output_tokens is not None:
            params["maxOutputTokens"] = max_output_tokens
        result = _effect_rpc("agents.spawn", params)
        if _result_occupied_write_path(result):
            self._gate.note_effect_attempt()
        return result

    def wait(self, handle_id: str, timeout_ms: int | None = None) -> dict[str, Any]:
        if not isinstance(handle_id, str) or not handle_id:
            raise TypeError("handle_id must be a non-empty string")
        params: dict[str, Any] = {"handleId": handle_id}
        if timeout_ms is not None:
            params["timeout_ms"] = timeout_ms
        result = _effect_rpc("agents.wait", params)
        if _result_occupied_write_path(result) or result.get("status") not in (None, "rejected"):
            # wait occupies on blocking path even on timeout
            err = result.get("error") if isinstance(result.get("error"), dict) else {}
            code = err.get("code") if isinstance(err, dict) else None
            if code != "AGENT_AUTH_DENIED" and code != "AGENT_PARAM_INVALID" and code != "AGENT_NOT_FOUND":
                if result.get("status") != "rejected" or code == "AGENT_WAIT_TIMEOUT":
                    self._gate.note_effect_attempt()
        return result

    def poll(self, handle_id: str) -> dict[str, Any]:
        if not isinstance(handle_id, str) or not handle_id:
            raise TypeError("handle_id must be a non-empty string")
        return _effect_rpc("agents.poll", {"handleId": handle_id})


class HelixMailboxBinding:
    """Kernel-side bounded mailbox binding."""

    def __init__(self, effect_gate: "CellEffectGate") -> None:
        self._gate = effect_gate

    def send(
        self,
        to: str,
        payload: Any,
        to_handle_id: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(to, str) or not to:
            raise TypeError("to must be a non-empty string")
        params: dict[str, Any] = {"to": to, "payload": payload}
        if to_handle_id is not None:
            params["to_handle_id"] = to_handle_id
        result = _effect_rpc("mailbox.send", params)
        if _result_occupied_write_path(result):
            self._gate.note_effect_attempt()
        return result

    def receive(
        self,
        mailbox_id: str | None = None,
        timeout_ms: int = 0,
    ) -> dict[str, Any] | None:
        params: dict[str, Any] = {"timeout_ms": int(timeout_ms)}
        if mailbox_id is not None:
            params["mailbox_id"] = mailbox_id
        result = _effect_rpc("mailbox.receive", params)
        # occupied when consumed or blocking timeout
        err = result.get("error") if isinstance(result.get("error"), dict) else None
        if result.get("msg_id") or (isinstance(err, dict) and err.get("code") == "MAILBOX_RECEIVE_TIMEOUT"):
            self._gate.note_effect_attempt()
        if result.get("message") is None and result.get("msg_id") is None:
            # empty non-blocking
            if isinstance(err, dict):
                return result
            return None
        return result

    def peek(self, mailbox_id: str | None = None) -> dict[str, Any] | None:
        params: dict[str, Any] = {}
        if mailbox_id is not None:
            params["mailbox_id"] = mailbox_id
        result = _effect_rpc("mailbox.peek", params)
        if result.get("message") is None and result.get("msg_id") is None:
            return None
        return result


class CellEffectGate:
    """Shared local (non-authoritative) single-effect counter for UX."""

    def __init__(self) -> None:
        self._effect_count = 0

    def begin_cell(self) -> None:
        self._effect_count = 0

    @property
    def effect_count(self) -> int:
        return self._effect_count

    def note_effect_attempt(self) -> None:
        # Local fast-fail UX. Host still enforces admission-before-occupy.
        if self._effect_count >= 1:
            # Factorio path raises; models.call Host path is authoritative.
            pass
        self._effect_count += 1


class FactorioBinding:
    def __init__(self, effect_gate: CellEffectGate) -> None:
        self._gate = effect_gate
        self.last: EffectResult | None = None

    def begin_cell(self) -> None:
        self._gate.begin_cell()

    def _request(self, method: str, params: dict[str, Any]) -> EffectResult:
        if self._gate.effect_count >= 1:
            raise RuntimeError("MULTIPLE_EFFECTS_IN_CELL: one reset or step per cell")
        self._gate.note_effect_attempt()
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
    apply_resource_limits()
    shell = InteractiveShell.instance()
    effect_gate = CellEffectGate()
    factorio = FactorioBinding(effect_gate)
    models = HelixModelsBinding(effect_gate)
    session = HelixSessionBinding(effect_gate)
    agents = HelixAgentsBinding(effect_gate)
    mailbox = HelixMailboxBinding(effect_gate)
    revision = 0

    while True:
        try:
            frame = receive()
        except EOFError:
            return
        request_type = frame.get("type")
        if frame.get("protocolVersion") != PROTOCOL_VERSION:
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "type": "execute_result",
                    "ok": False,
                    "error": {
                        "code": "PROTOCOL_VERSION_MISMATCH",
                        "message": "kernel protocol version mismatch",
                    },
                }
            )
            continue
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
        bootstrap = frame.get("bootstrap") or {}
        capabilities = bootstrap.get("capabilities") or {}
        recursive_cap = capabilities.get("recursiveModel") or {}
        recursive_enabled = bool(recursive_cap.get("enabled", False))
        session_async_cap = capabilities.get("sessionAsync") or {}
        session_async_enabled = bool(session_async_cap.get("enabled", False))
        session_boot = bootstrap.get("session") or {}

        helix_ns: dict[str, Any] = {
            "task": bootstrap.get("task"),
            "runtime": bootstrap.get("runtime"),
        }
        if recursive_enabled:
            helix_ns["models"] = models
        if session_async_enabled:
            session.configure(
                creation_token=session_boot.get("creationToken"),
                session_token=session_boot.get("sessionToken"),
                session_id=session_boot.get("sessionId"),
                actor=str(session_boot.get("actor") or "none"),
                handle_id=session_boot.get("handleId"),
            )
            helix_ns["session"] = session
            helix_ns["agents"] = agents
            helix_ns["mailbox"] = mailbox
        shell.user_ns["factorio"] = factorio
        shell.user_ns["helix"] = SimpleNamespace(**helix_ns)
        captured_stdout = BoundedTextBuffer(MAX_OUTPUT_CHARS)
        captured_stderr = BoundedTextBuffer(MAX_OUTPUT_CHARS)
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

        stdout = captured_stdout.getvalue()
        stderr = captured_stderr.getvalue()
        stdout_truncated = captured_stdout.truncated
        stderr_truncated = captured_stderr.truncated
        if (stdout_truncated or stderr_truncated) and error is None:
            error = {
                "code": "OUTPUT_LIMIT_EXCEEDED",
                "type": "ResourceError",
                "message": "cell output exceeded the 8 KiB capture budget",
            }
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
                "effectCount": effect_gate.effect_count,
                **({"error": error} if error else {}),
            }
        )



if __name__ == "__main__":
    main()
