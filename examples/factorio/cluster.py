"""Start and stop the pinned headless Factorio smoke-test container."""

from __future__ import annotations

import argparse
import platform
import socket
import subprocess
import time
from pathlib import Path

import fle

CONTAINER_NAME = "helix-factorio_0"
IMAGE = "factoriotools/factorio:2.0.73"
RCON_HOST_PORT = 27000
GAME_HOST_PORT = 34197


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def container_exists() -> bool:
    return run("docker", "inspect", CONTAINER_NAME, check=False).returncode == 0


def container_running() -> bool:
    result = run(
        "docker",
        "inspect",
        "--format",
        "{{.State.Running}}",
        CONTAINER_NAME,
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


def wait_for_rcon(timeout_seconds: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not container_running():
            logs = run("docker", "logs", CONTAINER_NAME, check=False).stderr
            raise RuntimeError(
                f"Factorio exited before RCON was ready:\n{logs[-4000:]}"
            )
        try:
            with socket.create_connection(("127.0.0.1", RCON_HOST_PORT), timeout=1.0):
                return
        except OSError:
            time.sleep(1)
    raise TimeoutError("Factorio RCON did not become ready within 60 seconds")


def start() -> None:
    if container_running():
        print(f"{CONTAINER_NAME} is already running")
        return
    if container_exists():
        run("docker", "rm", CONTAINER_NAME)

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
        "44340",
    ]
    command = [
        "docker",
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "--label",
        "io.xforce.helix.factorio-smoke=true",
        "--platform",
        docker_platform,
        "--user",
        "factorio",
        "-p",
        f"{GAME_HOST_PORT}:34197/udp",
        "-p",
        f"{RCON_HOST_PORT}:27015/tcp",
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
    wait_for_rcon()
    print(f"started {CONTAINER_NAME} ({result.stdout.strip()[:12]})")


def stop() -> None:
    if not container_exists():
        print(f"{CONTAINER_NAME} is not present")
        return
    label = run(
        "docker",
        "inspect",
        "--format",
        '{{index .Config.Labels "io.xforce.helix.factorio-smoke"}}',
        CONTAINER_NAME,
    ).stdout.strip()
    if label != "true":
        raise RuntimeError(f"refusing to remove unlabelled container {CONTAINER_NAME}")
    run("docker", "rm", "-f", CONTAINER_NAME)
    print(f"removed {CONTAINER_NAME}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "stop"))
    args = parser.parse_args()
    start() if args.command == "start" else stop()


if __name__ == "__main__":
    main()
