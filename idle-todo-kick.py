#!/usr/bin/env python3
"""Read-only Herdr snapshot diagnostics; external auto-recovery is retired.

Use --dry-run to report only snapshot pane/session identity and agent status.
These fields do not establish live editor contents, model, or task completion.
Recovery belongs exclusively to the in-process muse-watch extension.
OMO_IDLE_TODO_KICK=0 disables even snapshot access.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERDR = os.environ.get("HERDR_BIN", "herdr")


def enabled() -> bool:
    return os.environ.get("OMO_IDLE_TODO_KICK", "").lower() not in ("0", "false", "off", "no")


def read_snapshot() -> dict:
    env = os.environ.copy()
    env["PATH"] = str(Path.home() / ".local" / "bin") + os.pathsep + env.get("PATH", "")
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        completed = subprocess.run(
            [HERDR, "api", "snapshot"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=10,
            **flags,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Herdr snapshot timed out after 10s") from error
    if completed.returncode != 0:
        raise RuntimeError(f"Herdr snapshot failed (exit {completed.returncode})")
    payload = json.loads(completed.stdout)
    for envelope in ("result", "snapshot"):
        if not isinstance(payload, dict):
            raise ValueError("Herdr snapshot must be an object")
        if envelope in payload:
            payload = payload[envelope]
    if not isinstance(payload, dict):
        raise ValueError("Herdr snapshot must be an object")
    return payload


def identity_fields(record: dict, fields: tuple[str, ...]) -> dict:
    """Validate and allowlist machine fields at the snapshot boundary."""
    if not isinstance(record, dict):
        raise ValueError("Herdr snapshot entries must be objects")
    result = {}
    for field in fields:
        if field in record:
            value = record[field]
            if value is not None and not isinstance(value, str):
                raise ValueError(f"Herdr snapshot {field} must be a string or null")
            result[field] = value
    return result


def diagnostics(snapshot: dict) -> dict:
    agents = snapshot.get("agents")
    if agents is None or agents == []:
        agents = snapshot.get("panes", [])
    if agents is None:
        agents = []
    if not isinstance(agents, list):
        raise ValueError("Herdr snapshot agents/panes must be an array")
    records = []
    for agent in agents:
        record = identity_fields(agent, ("pane_id", "agent", "agent_status"))
        if "agent_session" in agent:
            session = agent["agent_session"]
            record["agent_session"] = (
                None if session is None else identity_fields(session, ("agent", "kind", "value"))
            )
        records.append(record)
    return {"agents": records}


def main() -> int:
    if sys.argv[1:] != ["--dry-run"]:
        print(
            "External auto-recovery is retired. Use --dry-run for read-only Herdr snapshot "
            "diagnostics; use the in-process muse-watch extension for recovery. "
            "Disable/remove old idle-todo-kick service or daemon launchers.",
            file=sys.stderr,
        )
        return 2
    if not enabled():
        print(json.dumps({"disabled": True}))
        return 0
    try:
        report = diagnostics(read_snapshot())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Snapshot diagnostics failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
