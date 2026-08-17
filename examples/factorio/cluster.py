"""Start and stop the pinned headless Factorio smoke-test container."""

from __future__ import annotations

import argparse
import platform
import subprocess
import time
from pathlib import Path

import fle
from factorio_rcon import RCONClient

CONTAINER_PREFIX = "helix-factorio_"
IMAGE = "factoriotools/factorio:2.0.73"
RCON_HOST_PORT = 27000
GAME_HOST_PORT = 34197


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def container_name(slot: int) -> str:
    return f"{CONTAINER_PREFIX}{slot}"


def container_exists(slot: int) -> bool:
    return run("docker", "inspect", container_name(slot), check=False).returncode == 0


def container_running(slot: int) -> bool:
    result = run(
        "docker",
        "inspect",
        "--format",
        "{{.State.Running}}",
        container_name(slot),
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def cluster_paths() -> tuple[Path, Path, Path, Path]:
    package_root = Path(fle.__file__).resolve().parent
    cluster_root = package_root / "cluster"
    screenshots = package_root.parent / ".fle" / "data" / "_screenshots"
    screenshots.mkdir(parents=True, exist_ok=True)
    return (
        cluster_root / "scenarios",
        cluster_root / "config",
        cluster_root / "mods",
        screenshots,
    )


def wait_for_rcon(slot: int, timeout_seconds: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not container_running(slot):
            logs = run("docker", "logs", container_name(slot), check=False).stderr
            raise RuntimeError(
                f"Factorio exited before RCON was ready:\n{logs[-4000:]}"
            )
        try:
            # A listening TCP socket is not enough: Factorio opens RCON before
            # the authentication handler is usable.  FLE creates this exact
            # client during reset, so wait for the same successful handshake.
            client = RCONClient(
                "127.0.0.1", RCON_HOST_PORT + slot, "factorio", timeout=1.0
            )
            client.close()
            return
        except Exception:
            time.sleep(1)
    raise TimeoutError("Factorio RCON authentication did not become ready within 60 seconds")


def start_one(slot: int) -> None:
    name = container_name(slot)
    if container_running(slot):
        print(f"{name} is already running")
        return
    if container_exists(slot):
        run("docker", "rm", name)

    scenarios, config, mods, screenshots = cluster_paths()
    is_arm = platform.machine().lower() in {"arm64", "aarch64"}
    docker_platform = "linux/arm64" if is_arm else "linux/amd64"
    emulator = ["/bin/box64"] if is_arm else []
    factorio_command = [
        *emulator,
        "/opt/factorio/bin/x64/factorio",
        "--start-server-load-scenario",
        "default_lab_scenario",
        "--port",
        "34197",
        "--server-settings",
        "/opt/factorio/config/server-settings.json",
        "--map-gen-settings",
        "/opt/factorio/config/map-gen-settings.json",
        "--map-settings",
        "/opt/factorio/config/map-settings.json",
        "--server-banlist",
        "/opt/factorio/config/server-banlist.json",
        "--rcon-port",
        "27015",
        "--rcon-password",
        "factorio",
        "--server-whitelist",
        "/opt/factorio/config/server-whitelist.json",
        "--use-server-whitelist",
        "--server-adminlist",
        "/opt/factorio/config/server-adminlist.json",
        "--mod-directory",
        "/opt/factorio/mods",
        "--map-gen-seed",
        str(44340 + slot),
    ]
    command = [
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "io.xforce.helix.factorio-smoke=true",
        "--platform",
        docker_platform,
        "--user",
        "factorio",
        "-p",
        f"{GAME_HOST_PORT + slot}:34197/udp",
        "-p",
        f"{RCON_HOST_PORT + slot}:27015/tcp",
        "-v",
        f"{scenarios}:/opt/factorio/scenarios",
        "-v",
        f"{config}:/opt/factorio/config",
        "-v",
        f"{screenshots}:/opt/factorio/script-output",
        "-v",
        f"{mods}:/opt/factorio/mods",
        "--entrypoint",
        "/bin/sh",
        IMAGE,
        "-c",
        "rm -rf /opt/factorio/data/elevated-rails "
        '/opt/factorio/data/quality /opt/factorio/data/space-age && exec "$@"',
        "helix-factorio",
        *factorio_command,
    ]
    result = run(*command)
    wait_for_rcon(slot)
    print(f"started {name} ({result.stdout.strip()[:12]})")


def start(count: int) -> None:
    if count < 1 or count > 32:
        raise ValueError("count must be between 1 and 32")
    for slot in range(count):
        start_one(slot)


def stop() -> None:
    listed = run(
        "docker", "ps", "-a", "--filter", "label=io.xforce.helix.factorio-smoke=true",
        "--format", "{{.Names}}",
    ).stdout.splitlines()
    names = sorted(name for name in listed if name.startswith(CONTAINER_PREFIX))
    if not names:
        print(f"no {CONTAINER_PREFIX} containers are present")
        return
    for name in names:
        run("docker", "rm", "-f", name)
        print(f"removed {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "stop"))
    parser.add_argument("--count", type=int, default=1, help="number of labelled FLE slots to start (1-32)")
    args = parser.parse_args()
    start(args.count) if args.command == "start" else stop()


if __name__ == "__main__":
    main()
