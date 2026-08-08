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

PROTOCOL_VERSION = "1"
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
        if isinstance(node, ast.Name) and node.id in DENIED_NAMES:
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
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id not in ALLOWED_CALLS
        ):
            raise ValueError(
                f"ACTION_CALL_NOT_ALLOWED: call {node.func.id!r} is not registered"
            )


def verification(observation: dict[str, Any]) -> dict[str, Any]:
    value = observation.get("task_verification") or {}
    return {
        "success": value.get("success") in (True, 1),
        "meta": value.get("meta") or [],
    }


def main() -> None:
    env = None
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        request = json.loads(line)
        request_id = request.get("id")
        method = request.get("method")
        if method == "close":
            if env is not None:
                with contextlib.redirect_stdout(
                    io.StringIO()
                ), contextlib.redirect_stderr(io.StringIO()):
                    env.close()
            send({"protocolVersion": PROTOCOL_VERSION, "id": request_id, "ok": True})
            return

        try:
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
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": True,
                    "result": result,
                }
            )
        except Exception as exc:
            message = str(exc)
            if message.startswith("POLICY_VIOLATION:"):
                code = "POLICY_VIOLATION"
            elif message.startswith("ACTION_CALL_NOT_ALLOWED:"):
                code = "ACTION_CALL_NOT_ALLOWED"
            elif message.startswith("ACTION_TOO_LARGE:"):
                code = "ACTION_TOO_LARGE"
            else:
                code = "FLE_EXECUTION_ERROR"
            send(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": code,
                        "type": type(exc).__name__,
                        "message": message,
                        "stateCertainty": (
                            "unchanged"
                            if method not in {"step"}
                            else "confirmed-or-observed"
                        ),
                        "traceback": traceback.format_exc(limit=5),
                    },
                }
            )

    if env is not None:
        env.close()


if __name__ == "__main__":
    main()
