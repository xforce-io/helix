"""Report immutable local FLE/task facts and a non-mutating RCON reachability check."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
from typing import Any

from factorio_rcon import RCONClient
from fle.env.gym_env.registry import get_environment_info

TASK_ID = "iron_ore_throughput"


def canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )


def digest(value: Any) -> str:
    encoded = canonical_json(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def main() -> None:
    task = get_environment_info(TASK_ID)
    if task is None:
        raise RuntimeError(f"FLE did not register required task: {TASK_ID}")
    authenticated = False
    try:
        client = RCONClient("127.0.0.1", 27000, "factorio", timeout=2.0)
        client.close()
        authenticated = True
    except Exception:
        pass
    print(
        json.dumps(
            {
                "fle": importlib.metadata.version("factorio-learning-environment"),
                "taskId": TASK_ID,
                "taskDigest": digest(task),
                "rconAuthenticated": authenticated,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
