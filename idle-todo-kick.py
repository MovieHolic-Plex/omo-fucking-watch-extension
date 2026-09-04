#!/usr/bin/env python3
"""Kick idle OmO panes that still have open todos.

In-process muse-watch never sees a session that already stopped at ❯.
This watcher reads Herdr from outside the omo process, so /reload and
omo -r are not required.

Disable: OMO_IDLE_TODO_KICK=0
Tune:    OMO_IDLE_TODO_KICK_EVERY_MS (default 15000)
         OMO_IDLE_TODO_KICK_COOLDOWN_MS (default 90000)
         OMO_IDLE_TODO_KICK_MAX (default 6)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

EVERY_MS = int(os.environ.get("OMO_IDLE_TODO_KICK_EVERY_MS", "15000"))
COOLDOWN_MS = int(os.environ.get("OMO_IDLE_TODO_KICK_COOLDOWN_MS", "90000"))
MAX_KICKS = int(os.environ.get("OMO_IDLE_TODO_KICK_MAX", "6"))
HERDR = os.environ.get("HERDR_BIN", "herdr")
STATE_PATH = Path(
    os.environ.get(
        "OMO_IDLE_TODO_KICK_STATE",
        str(Path.home() / ".omo" / "agent" / "idle-todo-kick-state.json"),
    )
)
LOG_PATH = Path(
    os.environ.get(
        "OMO_IDLE_TODO_KICK_LOG",
        str(Path.home() / ".omo" / "agent" / "logs" / "idle-todo-kick.log"),
    )
)

OPEN_MARK = re.compile(r"^\s*\[(?:•| |·|-|o|O)\]\s+(\S.*\S|\S)\s*$")
DONE_MARK = re.compile(r"^\s*\[(?:✓|✔|x|X)\]\s+")
TODO_HEAD = re.compile(r"^\s*Todo\s*$", re.I)
PROMPT = re.compile(r"^\s*❯")
RULE = re.compile(r"^-{8,}")
MUSE_RE = re.compile(r"muse-spark", re.I)

CONTINUE = (
    "You ended the turn while todo work is still open. That is a premature stop. "
    "Continue the same task now. Do not wait for the user. Do not restart from scratch.\n"
    "Open todos:\n"
)
CONTRACT_CONTINUE = (
    "You ended the turn before your declared stop-when contract held. That is a premature stop. "
    "Continue the same task now. Do not wait for the user. Do not restart from scratch.\n"
    "Unmet contract:\n"
)
STOP_WHEN_RE = re.compile(r"I(?:['’]ll| will) stop when\s+(.+?)(?:\.|$)", re.I)
PR_URL_RE = re.compile(r"github\.com/[^\s)\]>'\"]+/pull/\d+", re.I)
NEEDS_PR_RE = re.compile(r"\bpr\b|pull request|pr url", re.I)
USER_WAIT_RE = re.compile(
    r"\b(you confirm|your answer|the user|user replies|you say|wait for (?:the )?user)\b",
    re.I,
)
SESSIONS_DIR = Path.home() / ".omo" / "agent" / "sessions"


def enabled() -> bool:
    raw = os.environ.get("OMO_IDLE_TODO_KICK", "")
    if raw == "":
        return True
    return raw.lower() not in ("0", "false", "off", "no")


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}"
    print(line, flush=True)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def hidden_run_kwargs() -> dict:
    """Keep herdr/python from flashing a console on Windows."""
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


def herdr(*args: str) -> str:
    env = os.environ.copy()
    extra = str(Path.home() / ".local" / "bin")
    env["PATH"] = extra + os.pathsep + env.get("PATH", "")
    completed = subprocess.run(
        [HERDR, *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        **hidden_run_kwargs(),
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or f"herdr {' '.join(args)} failed")
    return completed.stdout


def unwrap(raw: str):
    payload = json.loads(raw)
    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    return payload


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def session_jsonl_for_cwd(cwd: str) -> Path | None:
    if not SESSIONS_DIR.is_dir() or not cwd:
        return None
    needle = cwd.replace("\\", "-").replace("/", "-").replace(":", "")
    hits: list[tuple[float, Path]] = []
    for folder in SESSIONS_DIR.iterdir():
        if not folder.is_dir():
            continue
        if needle not in folder.name and Path(cwd).name not in folder.name:
            continue
        for jsonl in folder.glob("*.jsonl"):
            try:
                hits.append((jsonl.stat().st_mtime, jsonl))
            except OSError:
                continue
    if not hits:
        return None
    hits.sort(reverse=True)
    return hits[0][1]


def unfinished_from_jsonl(cwd: str) -> tuple[str, list[str]]:
    path = session_jsonl_for_cwd(cwd)
    if path is None:
        return ("", [])
    when = ""
    has_pull = False
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                blob = json.dumps(entry, ensure_ascii=False)
                if PR_URL_RE.search(blob):
                    has_pull = True
                if entry.get("customType") == "muse-watch.contract" and isinstance(entry.get("data"), dict):
                    when = str(entry["data"].get("when") or "")
                    continue
                message = entry.get("message") if entry.get("type") == "message" else entry
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                content = message.get("content")
                text = content if isinstance(content, str) else ""
                if isinstance(content, list):
                    text = "\n".join(
                        str(block.get("text") or "")
                        for block in content
                        if isinstance(block, dict) and block.get("type") == "text"
                    )
                match = STOP_WHEN_RE.search(text)
                if match:
                    when = match.group(1).strip()
    except OSError:
        return ("", [])
    if not when or USER_WAIT_RE.search(when):
        return ("", [])
    if NEEDS_PR_RE.search(when) and not has_pull:
        return ("contract", [f"I'll stop when {when}"])
    return ("", [])


def parse_open_todos(text: str) -> list[str]:
    lines = text.replace("\r\n", "\n").split("\n")
    last_head = -1
    for i, line in enumerate(lines):
        if TODO_HEAD.match(line):
            last_head = i
    if last_head < 0:
        return []
    open_todos: list[str] = []
    for line in lines[last_head + 1 :]:
        if PROMPT.match(line) or RULE.match(line):
            break
        if DONE_MARK.match(line):
            continue
        match = OPEN_MARK.match(line)
        if match:
            open_todos.append(match.group(1).strip())
    return open_todos


def snapshot_agents() -> list[dict]:
    payload = unwrap(herdr("api", "snapshot"))
    snap = payload.get("snapshot", payload)
    agents = snap.get("agents") or []
    if not agents:
        agents = snap.get("panes") or []
    return agents


def idle_omo_panes() -> list[dict]:
    out = []
    for agent in snapshot_agents():
        if agent.get("agent") != "omo":
            continue
        status = agent.get("agent_status") or ""
        if status in ("working", "streaming"):
            continue
        pane_id = agent.get("pane_id")
        if not pane_id:
            continue
        out.append(agent)
    return out


def pane_text(pane_id: str) -> str:
    return herdr("pane", "read", "--lines", "60", "--format", "text", pane_id)


def should_skip_prompt(text: str) -> bool:
    tail = "\n".join(text.replace("\r\n", "\n").split("\n")[-12:])
    if "Reloading keybindings" in tail:
        return True
    if "select" in tail.lower() and "enter" in tail.lower() and "❯" not in tail:
        return True
    return "❯" not in tail


def kick(pane_id: str, open_items: list[str], kind: str) -> None:
    listed = "\n".join(f"- {item}" for item in open_items[:8])
    extra = f"\n- …and {len(open_items) - 8} more" if len(open_items) > 8 else ""
    prefix = CONTRACT_CONTINUE if kind == "contract" else CONTINUE
    herdr("pane", "send-text", pane_id, prefix + listed + extra)
    herdr("pane", "send-keys", pane_id, "Enter")


def tick(state: dict) -> dict:
    now = int(time.time() * 1000)
    for agent in idle_omo_panes():
        pane_id = agent["pane_id"]
        label = agent.get("terminal_title_stripped") or agent.get("cwd") or pane_id
        try:
            text = pane_text(pane_id)
        except RuntimeError as error:
            log(f"skip {pane_id} read: {error}")
            continue
        if not MUSE_RE.search(text):
            continue
        if should_skip_prompt(text):
            continue
        open_todos = parse_open_todos(text)
        kind = "todos"
        items = open_todos
        if not items:
            kind, items = unfinished_from_jsonl(str(agent.get("cwd") or ""))
        if not items:
            continue
        sig = kind + "\n" + "\n".join(items)
        entry = state.get(pane_id) or {}
        if entry.get("sig") != sig:
            entry = {"sig": sig, "kicks": 0, "last": 0}
        if entry["kicks"] >= MAX_KICKS:
            log(f"max {pane_id} {label} {kind}={len(items)}")
            state[pane_id] = entry
            continue
        if now - int(entry.get("last") or 0) < COOLDOWN_MS:
            continue
        try:
            kick(pane_id, items, kind)
        except RuntimeError as error:
            log(f"fail {pane_id} {error}")
            continue
        entry["kicks"] = int(entry.get("kicks") or 0) + 1
        entry["last"] = now
        entry["sig"] = sig
        state[pane_id] = entry
        log(f"kick {pane_id} {label} #{entry['kicks']} {kind}={len(items)} {items[0][:80]}")
    return state


def pythonw_executable() -> str:
    exe = Path(sys.executable)
    if os.name == "nt":
        candidate = exe.with_name("pythonw.exe")
        if candidate.exists():
            return str(candidate)
    return str(exe)


def spawn_daemon() -> int:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    pid_path = Path(os.environ.get("OMO_IDLE_TODO_KICK_PID", str(STATE_PATH.with_name("idle-todo-kick.pid"))))
    child_args = [a for a in sys.argv[1:] if a != "--daemon"]
    cmd = [pythonw_executable(), str(Path(__file__).resolve()), *child_args]
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        flags |= getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    out = LOG_PATH.open("a", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        stdout=out,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        close_fds=True,
        creationflags=flags,
        start_new_session=os.name != "nt",
        **({} if os.name == "nt" else {}),
    )
    pid_path.write_text(str(proc.pid), encoding="utf-8")
    log(f"daemon {proc.pid} {cmd[0]}")
    print(f"started {proc.pid} (headless)", flush=True)
    return 0


def main() -> int:
    if not enabled():
        log("disabled")
        return 0
    if "--daemon" in sys.argv:
        return spawn_daemon()
    once = "--once" in sys.argv
    dry = "--dry-run" in sys.argv
    state = load_state()
    if dry:
        for agent in idle_omo_panes():
            pane_id = agent["pane_id"]
            try:
                text = pane_text(pane_id)
            except RuntimeError as error:
                log(f"dry {pane_id} read: {error}")
                continue
            open_todos = parse_open_todos(text)
            kind, contract_items = unfinished_from_jsonl(str(agent.get("cwd") or ""))
            muse = bool(MUSE_RE.search(text))
            skip = should_skip_prompt(text)
            log(
                f"dry {pane_id} status={agent.get('agent_status')} muse={muse} skip={skip} todos={len(open_todos)} contract={contract_items[:1]} {open_todos[:3]}"
            )
        return 0
    if once:
        save_state(tick(state))
        return 0
    log(f"start every={EVERY_MS}ms cooldown={COOLDOWN_MS}ms max={MAX_KICKS}")
    while True:
        try:
            state = tick(state)
            save_state(state)
        except Exception as error:  # noqa: BLE001 — loop must not die
            log(f"tick error: {error}")
        time.sleep(max(EVERY_MS, 1000) / 1000)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
