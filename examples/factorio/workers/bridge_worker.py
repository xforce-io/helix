"""FLE Bridge worker for the Helix Factorio example."""

from __future__ import annotations

import ast
import contextlib
import io
import json
import sys
import time
import traceback
from typing import Any

import gym
from fle.commons.models.game_state import GameState
from fle.env.gym_env.action import Action

PROTOCOL_VERSION = "2"
TASK_ID = "iron_ore_throughput"
MAX_ACTION_CHARS = 10_000
ALLOWED_CALLS = {
    "BuildingBox",
    "BoundingBox",
    "Position",
    "abs",
    "all",
    "any",
    "bool",
    "can_place_entity",
    "connect_entities",
    "craft_item",
    "dict",
    "enumerate",
    "extract_item",
    "float",
    "get_entities",
    "get_entity",
    "get_connection_amount",
    "get_factory_centroid",
    "get_path",
    "get_production_stats",
    "get_prototype_recipe",
    "get_resource_patch",
    "hasattr",
    "insert_item",
    "inspect_entities",
    "inspect_inventory",
    "int",
    "isinstance",
    "len",
    "list",
    "max",
    "min",
    "move_to",
    "nearest",
    "nearest_buildable",
    "pickup_entity",
    "place_entity",
    "place_entity_next_to",
    "print",
    "range",
    "reversed",
    "round",
    "request_path",
    "rotate_entity",
    "set",
    "set_entity_recipe",
    "shift_entity",
    "sleep",
    "sorted",
    "str",
    "sum",
    "tuple",
    "zip",
}
DENIED_NAMES = {
    "__import__",
    "compile",
    "eval",
    "exec",
    "globals",
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


def validate_action(program: str) -> None:
    if len(program) > MAX_ACTION_CHARS:
        raise ValueError("ACTION_TOO_LARGE: program exceeds 10,000 characters")
    tree = ast.parse(program, mode="exec")
    # First reject actual boundary violations. Do this before reporting an
    # unknown public call so a later eval/import cannot be masked by an
    # earlier capability typo in the same program.
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal)):
            raise ValueError(f"POLICY_VIOLATION: {type(node).__name__} is forbidden")
        if isinstance(node, ast.Name) and (
            node.id in DENIED_NAMES or node.id.startswith("_")
        ):
            raise ValueError(f"POLICY_VIOLATION: name {node.id!r} is forbidden")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError("POLICY_VIOLATION: private attributes are forbidden")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "hasattr":
                if (
                    len(node.args) != 2
                    or not isinstance(node.args[1], ast.Constant)
                    or not isinstance(node.args[1].value, str)
                    or node.args[1].value.startswith("_")
                ):
                    raise ValueError(
                        "POLICY_VIOLATION: hasattr requires a public literal attribute"
                    )
    # A non-denied but unavailable call is an API/capability mistake. It is
    # still blocked before execution, but remains recoverable model feedback.
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id not in ALLOWED_CALLS:
                raise ValueError(
                    f"ACTION_CALL_NOT_ALLOWED: call {node.func.id!r} is not registered"
                )
            if isinstance(node.func, ast.Attribute):
                raise ValueError(
                    f"ACTION_CALL_NOT_ALLOWED: method {node.func.attr!r} is not registered"
                )
            if not isinstance(node.func, ast.Name):
                raise ValueError("POLICY_VIOLATION: dynamic callable expressions are forbidden")


def classify_error(
    exc: Exception, method: str | None, action_started: bool
) -> tuple[str, str]:
    message = str(exc)
    if message.startswith("POLICY_VIOLATION:"):
        return "POLICY_VIOLATION", "unchanged"
    if message.startswith("ACTION_CALL_NOT_ALLOWED:"):
        return "ACTION_CALL_NOT_ALLOWED", "unchanged"
    if message.startswith("ACTION_TOO_LARGE:"):
        return "ACTION_TOO_LARGE", "unchanged"
    if method == "step" and action_started:
        return "FLE_EXECUTION_ERROR", "uncertain"
    return "FLE_EXECUTION_ERROR", "unchanged"


class CommandLedger:
    def __init__(self) -> None:
        self._completed: dict[str, tuple[str, dict[str, Any]]] = {}

    def get(self, command_id: str, input_digest: str) -> dict[str, Any] | None:
        completed = self._completed.get(command_id)
        if completed is None:
            return None
        previous_digest, response = completed
        if previous_digest != input_digest:
            raise ValueError(
                "COMMAND_ID_CONFLICT: same commandId was used with different input"
            )
        return response

    def remember(
        self, command_id: str, input_digest: str, response: dict[str, Any]
    ) -> dict[str, Any]:
        self._completed[command_id] = (input_digest, response)
        return response

    def execute(
        self, command_id: str, input_digest: str, operation: Any
    ) -> dict[str, Any]:
        completed = self.get(command_id, input_digest)
        if completed is not None:
            return completed
        return self.remember(command_id, input_digest, operation())


def verification(observation: dict[str, Any]) -> dict[str, Any]:
    value = observation.get("task_verification") or {}
    return {
        "success": value.get("success") in (True, 1),
        "meta": value.get("meta") or [],
    }


def main() -> None:
    env = None
    ledger = CommandLedger()
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        request = json.loads(line)
        request_id = request.get("id")
        method = request.get("method")
        if request.get("protocolVersion") != PROTOCOL_VERSION:
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "PROTOCOL_VERSION_MISMATCH",
                        "message": "bridge protocol version mismatch",
                        "stateCertainty": "unchanged",
                    },
                }
            )
            continue
        if method == "close":
            if env is not None:
                with contextlib.redirect_stdout(
                    io.StringIO()
                ), contextlib.redirect_stderr(io.StringIO()):
                    env.close()
            send({"protocolVersion": PROTOCOL_VERSION, "id": request_id, "ok": True})
            return

        command_id = request.get("commandId")
        if not isinstance(command_id, str) or not command_id:
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "BAD_REQUEST",
                        "message": "commandId is required",
                        "stateCertainty": "unchanged",
                    },
                }
            )
            continue
        input_digest = json.dumps(
            {"method": method, "params": request.get("params") or {}},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        try:
            completed = ledger.get(command_id, input_digest)
        except ValueError as exc:
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "COMMAND_ID_CONFLICT",
                        "message": str(exc),
                        "stateCertainty": "unchanged",
                    },
                }
            )
            continue
        if completed is not None:
            send({**completed, "id": request_id})
            continue

        try:
            action_started = False
            logs = io.StringIO()
            with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
                if method == "reset":
                    if env is None:
                        env = gym.make(TASK_ID, run_idx=0)
                    observation, _ = env.reset(options={"game_state": None})
                    state_raw = GameState.from_instance(env.unwrapped.instance).to_raw()
                    result = {
                        "observation": observation,
                        "stateRaw": state_raw,
                        "reward": 0.0,
                        "terminated": False,
                        "truncated": False,
                        "info": {},
                        "stepSeconds": 0.0,
                        "actionCapabilities": sorted(ALLOWED_CALLS),
                    }
                elif method == "step":
                    if env is None:
                        raise RuntimeError(
                            "EPISODE_NOT_RESET: call factorio.reset() first"
                        )
                    program = request.get("params", {}).get("program")
                    if not isinstance(program, str):
                        raise TypeError("program must be a string")
                    validate_action(program)
                    state_raw = request.get("params", {}).get("stateRaw")
                    state = GameState.parse_raw(state_raw) if state_raw else None
                    started = time.monotonic()
                    action_started = True
                    observation, reward, terminated, truncated, info = env.step(
                        Action(code=program, agent_idx=0, game_state=state)
                    )
                    elapsed = time.monotonic() - started
                    output_state = info.pop("output_game_state")
                    result = {
                        "observation": observation,
                        "stateRaw": output_state.to_raw(),
                        "reward": reward,
                        "terminated": terminated,
                        "truncated": truncated,
                        "stepSeconds": elapsed,
                        "info": info,
                        "actionCapabilities": sorted(ALLOWED_CALLS),
                    }
                else:
                    raise ValueError(f"UNKNOWN_METHOD: {method!r}")
            result["verification"] = verification(result["observation"])
            result["bridgeLogs"] = logs.getvalue()[-8_192:]
            response = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": True,
                    "result": result,
                }
            ledger.remember(command_id, input_digest, response)
            send(response)
        except Exception as exc:
            message = str(exc)
            code, state_certainty = classify_error(exc, method, action_started)
            response = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": code,
                        "type": type(exc).__name__,
                        "message": message,
                        "stateCertainty": state_certainty,
                        "traceback": traceback.format_exc(limit=5),
                    },
                }
            ledger.remember(command_id, input_digest, response)
            send(response)

    if env is not None:
        env.close()


if __name__ == "__main__":
    main()
