"""Run one real Factorio Learning Environment verification task.

This is the live-environment gate for the example. It deliberately refuses a
fake adapter and writes a machine-readable evidence file. The model-owned RLM
loop will reuse this boundary; this first vertical proves the real game and
verifier are reachable.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import gym
from fle.env.gym_env.action import Action
from fle.env.gym_env.registry import get_environment_info

TASK_ID = "iron_ore_throughput"
EVIDENCE_SCHEMA = "helix.factorio.live-smoke/v1"
MAX_ACTION_CHARS = 10_000
MAX_STEP_SECONDS = 120.0

ACTION_PROGRAM = """\
iron = nearest(Resource.IronOre)
move_to(iron)

drills = []
for index in range(2):
    # Burner drills occupy a 3x3 footprint; keep the output chests apart too.
    position = Position(x=iron.x + 5 * index, y=iron.y)
    move_to(position)
    drill = place_entity(
        Prototype.BurnerMiningDrill,
        position=position,
        direction=Direction.DOWN,
    )
    drill = insert_item(Prototype.Coal, drill, quantity=50)
    chest = place_entity(Prototype.WoodenChest, position=drill.drop_position)
    drills.append(drill)
    print(f"miner[{index}]={drill.position} output={chest.position}")

print(f"automatic_miners={len(drills)}")
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence",
        type=Path,
        default=Path("artifacts/factorio/live-smoke.json"),
        help="Canonical JSON evidence output path.",
    )
    return parser.parse_args()


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def verification_success(observation: dict[str, Any]) -> bool:
    verification = observation.get("task_verification") or {}
    return verification.get("success") in (True, 1)


def main() -> int:
    args = parse_args()
    if os.getenv("HELIX_FACTORIO_ADAPTER", "fle") != "fle":
        raise RuntimeError("Live verification refuses non-FLE adapters")
    if len(ACTION_PROGRAM) > MAX_ACTION_CHARS:
        raise RuntimeError("Action program exceeds FLE's 10,000 character limit")

    task_info = get_environment_info(TASK_ID)
    if task_info is None:
        raise RuntimeError(f"FLE did not register required task: {TASK_ID}")

    started_at = time.time()
    env = None
    evidence: dict[str, Any] = {
        "schema": EVIDENCE_SCHEMA,
        "verdict": "fail",
        "adapter": {"kind": "fle", "mode": "live"},
        "task": {"id": TASK_ID, "metadata": task_info},
        "pins": {
            "fle": importlib.metadata.version("factorio-learning-environment"),
            "factorioServer": "2.0.73",
            "taskDigest": sha256_text(canonical_json(task_info)),
            "actionDigest": sha256_text(ACTION_PROGRAM),
        },
        "checks": [],
    }

    try:
        env = gym.make(TASK_ID, run_idx=0)
        initial_observation, _ = env.reset(options={"game_state": None})
        initial_tick = int(initial_observation["game_info"]["tick"])

        step_started = time.monotonic()
        observation, reward, terminated, truncated, info = env.step(
            Action(code=ACTION_PROGRAM, agent_idx=0, game_state=None)
        )
        step_seconds = time.monotonic() - step_started

        checks = {
            "liveAdapter": True,
            "actionWithinLimit": len(ACTION_PROGRAM) <= MAX_ACTION_CHARS,
            "stepWithinLimit": step_seconds <= MAX_STEP_SECONDS,
            "environmentAdvanced": int(observation["game_info"]["tick"]) > initial_tick,
            "actionHadNoError": not bool(info.get("error_occurred")),
            "automaticMinersExist": sum(
                1
                for entity in observation.get("entities", [])
                if entity.get("name") == "burner-mining-drill"
            )
            >= 2,
            "fleVerifierSuccess": verification_success(observation),
            "terminatedByVerifier": bool(terminated) and not bool(truncated),
        }
        evidence.update(
            {
                "verdict": "pass" if all(checks.values()) else "fail",
                "timing": {
                    "stepSeconds": step_seconds,
                    "totalSeconds": time.time() - started_at,
                },
                "result": {
                    "initialTick": initial_tick,
                    "finalTick": int(observation["game_info"]["tick"]),
                    "reward": float(reward),
                    "terminated": bool(terminated),
                    "truncated": bool(truncated),
                    "taskVerification": observation.get("task_verification"),
                    "rawTextPreview": str(observation.get("raw_text", ""))[:8192],
                    "entityCount": len(observation.get("entities", [])),
                    "productionScore": float(info.get("production_score", 0.0)),
                    "automatedProductionScore": float(
                        info.get("automated_production_score", 0.0)
                    ),
                },
                "checks": [
                    {"id": name, "passed": passed} for name, passed in checks.items()
                ],
            }
        )
    except Exception as error:
        evidence["error"] = {
            "type": type(error).__name__,
            "message": str(error),
        }
    finally:
        if env is not None:
            env.close()
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        encoded = canonical_json(evidence)
        args.evidence.write_text(f"{encoded}\n", encoding="utf-8")
        print(json.dumps(evidence, ensure_ascii=False, indent=2, default=str))
        print(f"evidence={args.evidence.resolve()}")

    return 0 if evidence["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
