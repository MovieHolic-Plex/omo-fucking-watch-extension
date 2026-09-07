import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "idle-todo-kick.py"
SPEC = importlib.util.spec_from_file_location("idle_todo_kick", SCRIPT)
kicker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kicker)


class KickerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()
        self.cwd = "/work/project"
        # Legacy locations remain populated to prove they are never consulted.
        for name, value in (
            ("SESSIONS_DIR", self.sessions),
            ("STATE_PATH", self.root / "state.json"),
            ("LOG_PATH", self.root / "watch.log"),
        ):
            mock = patch.object(kicker, name, value, create=True)
            mock.start()
            self.addCleanup(mock.stop)

    def session(self, session_id="one", cwd=None, when="a PR URL is available", mtime=100):
        cwd = self.cwd if cwd is None else cwd
        folder = self.sessions / ("--" + cwd.replace("/", "-").strip("-") + "--")
        folder.mkdir(exist_ok=True)
        path = folder / f"2026-09-07T00-00-00-000Z_{session_id}.jsonl"
        entries = [
            {"type": "session", "id": session_id, "cwd": cwd},
            {"type": "custom", "customType": "muse-watch.contract", "data": {"when": when}},
        ]
        path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
        os.utime(path, (mtime, mtime))
        return path

    def append_message(self, path, message):
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"type": "message", "message": message}) + "\n")

    def agent(self, identity=None, pane="pane-1", status="idle"):
        agent = {"agent": "omo", "agent_status": status, "pane_id": pane, "cwd": self.cwd}
        if identity is not None:
            agent["agent_session"] = identity
        return agent

    def invoke(self, args, payload=None, disabled="", error=None):
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            self.assertEqual(command, [kicker.HERDR, "api", "snapshot"])
            self.assertEqual(kwargs["timeout"], 10)
            if error is not None:
                raise error
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, {"OMO_IDLE_TODO_KICK": disabled}),
            patch.object(sys, "argv", [str(SCRIPT), *args]),
            patch.object(kicker.subprocess, "run", side_effect=run),
            patch.object(kicker.subprocess, "Popen", side_effect=AssertionError("daemon spawn")),
            patch.object(Path, "open", side_effect=AssertionError("local file access")),
            patch.object(Path, "mkdir", side_effect=AssertionError("directory write")),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = kicker.main()
        return code, stdout.getvalue(), stderr.getvalue(), calls

    def assert_read_only(self, agents, screen="muse-spark\n❯"):
        # Screen/title/model/prose bait must never influence or appear in diagnostics.
        enriched = [dict(agent, screen=screen, terminal_title_stripped=screen,
                         model="muse-spark", editor="draft", completion="unfinished")
                    for agent in agents]
        code, stdout, stderr, calls = self.invoke(
            ["--dry-run"], {"result": {"snapshot": {"agents": enriched}}}
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(calls, [[kicker.HERDR, "api", "snapshot"]])
        fields = ("pane_id", "agent", "agent_status", "agent_session")
        self.assertEqual(json.loads(stdout), {
            "agents": [{key: agent[key] for key in fields if key in agent} for agent in agents]
        })
        self.assertFalse((self.root / "state.json").exists())
        self.assertFalse((self.root / "watch.log").exists())

    # These replace the old contract/todo auto-send assertions with the opposite
    # contract, retaining their inputs and forbidding all pane and session reads.
    def test_negated_pr_contracts_are_read_only(self):
        for when in (
            "the goal is met and committed with no PR/merge",
            "the changes are committed without a PR",
            "the changes are committed with no pull request",
            "the changes are committed; a PR is not required",
            "the changes are committed; do not open a PR",
            "the changes are committed without creating a pull request",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                self.assert_read_only([self.agent()])

    def test_positive_pr_contracts_no_longer_kick(self):
        for when in ("a PR URL is available", "tests have no failures and a PR URL is available"):
            with self.subTest(when=when):
                self.session(when=when)
                self.assert_read_only([self.agent()])

    def test_independent_pr_requirement_no_longer_kicks(self):
        for when in (
            "the PR URL is available without creating a PR",
            "the PR URL is available without opening another PR",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                self.assert_read_only([self.agent()])

    def test_negated_pr_articles_and_urls_are_read_only(self):
        for when in (
            "the changes are committed without opening another PR",
            "the changes are committed without an PR URL",
            "the changes are committed with no PR URL",
            "the changes are committed; a PR URL is not required",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                self.assert_read_only([self.agent()])

    def test_assistant_negated_contract_is_not_read(self):
        self.append_message(self.session(), {
            "role": "assistant", "content": [{"type": "text", "text":
                "I'll stop when the goal is met and committed with no PR/merge."}]
        })
        self.assert_read_only([self.agent()])

    def test_satisfied_and_user_wait_contracts_are_not_read(self):
        self.append_message(self.session(), {
            "role": "assistant", "content": "https://github.com/org/repo/pull/42"
        })
        self.assert_read_only([self.agent()])
        self.session(when="you confirm the PR")
        self.assert_read_only([self.agent()])

    def test_same_basename_does_not_trigger_session_lookup(self):
        self.session(cwd="/other/project")
        self.assert_read_only([self.agent()])

    def test_cwd_prefix_does_not_trigger_session_lookup(self):
        self.session(cwd=self.cwd + "-other")
        self.assert_read_only([self.agent()])

    def test_newest_same_cwd_session_is_not_inferred(self):
        self.session("old", when="tests pass", mtime=100)
        self.session("new", mtime=200)
        self.assert_read_only([self.agent(), self.agent(pane="pane-2")])

    def test_unique_exact_cwd_session_is_not_read(self):
        self.session()
        self.assert_read_only([self.agent()])

    def test_exact_session_identity_is_reported_without_reading(self):
        old = self.session("old", mtime=100)
        self.session("new", when="tests pass", mtime=200)
        for kind, value in (("id", "old"), ("path", str(old))):
            with self.subTest(kind=kind):
                self.assert_read_only([self.agent({"agent": "omo", "kind": kind, "value": value})])

    def test_missing_or_foreign_identity_never_falls_back(self):
        self.session()
        for identity in (
            {"agent": "omo", "kind": "id", "value": "missing"},
            {"agent": "omo", "kind": "path", "value": str(self.root / "missing.jsonl")},
            {"agent": "claude", "kind": "id", "value": "one"},
            {"agent": "omo", "kind": "unknown", "value": "one"},
        ):
            with self.subTest(identity=identity):
                self.assert_read_only([self.agent(identity)])

    def test_duplicate_session_id_is_not_resolved(self):
        self.session()
        self.session(cwd="/other/project")
        self.assert_read_only([self.agent({"agent": "omo", "kind": "id", "value": "one"})])

    def test_session_header_is_not_read(self):
        path = self.session("wrong")
        path.rename(path.with_name(path.name.replace("_wrong.jsonl", "_one.jsonl")))
        self.assert_read_only([self.agent({"agent": "omo", "kind": "id", "value": "one"})])

    def test_unreadable_candidate_is_not_read(self):
        self.session("one")
        self.session("two").write_text("{", encoding="utf-8")
        self.assert_read_only([self.agent()])

    def test_todos_with_ambiguous_sessions_no_longer_kick(self):
        self.session("one")
        self.session("two")
        self.assert_read_only([self.agent()], "muse-spark\nTodo\n[ ] finish implementation\n❯")

    def test_dry_run_reports_exact_session_identity(self):
        old = self.session("old", when="tests pass", mtime=100)
        self.session("new", mtime=200)
        self.assert_read_only([self.agent({"agent": "omo", "kind": "path", "value": str(old)})])

    def test_user_aborted_and_live_drafts_are_never_touched(self):
        for screen in (
            "muse-spark\nTodo\n[ ] work\nUser aborted\n❯",
            "muse-spark\nTodo\n[ ] work\n❯ keep this unsent draft",
            "muse-spark\nReloading keybindings\n❯",
            "select an option and press enter",
        ):
            with self.subTest(screen=screen):
                self.assert_read_only([self.agent()], screen)

    def test_non_muse_screen_mention_does_not_infer_model(self):
        self.assert_read_only([self.agent()], "claude\nquoted muse-spark\nTodo\n[ ] work\n❯")

    def test_busy_and_foreign_agents_are_reported_not_classified(self):
        agents = [self.agent(status=status) for status in ("working", "streaming", "idle", "unknown")]
        agents.append(dict(self.agent(), agent="claude"))
        self.assert_read_only(agents)

    def test_all_supported_snapshot_envelopes(self):
        agents = [self.agent()]
        expected = {"agents": [{"pane_id": "pane-1", "agent": "omo", "agent_status": "idle"}]}
        for payload in (
            {"agents": agents}, {"panes": agents}, {"agents": [], "panes": agents},
            {"snapshot": {"agents": agents}}, {"result": {"agents": agents}},
            {"result": {"snapshot": {"panes": agents}}},
        ):
            with self.subTest(payload=payload):
                code, stdout, stderr, _ = self.invoke(["--dry-run"], payload)
                self.assertEqual((code, stderr), (0, ""))
                self.assertEqual(json.loads(stdout), expected)

    def test_absent_fields_are_not_fabricated(self):
        self.assert_read_only([{}, {"pane_id": "pane-1"}, {"agent_status": None}])
        code, stdout, stderr, _ = self.invoke(["--dry-run"], {})
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(json.loads(stdout), {"agents": []})

    def test_session_extra_fields_are_not_exposed(self):
        identity = {"agent": "omo", "kind": "id", "value": "one", "model": "muse-spark", "editor": "draft"}
        code, stdout, stderr, _ = self.invoke(["--dry-run"], {"agents": [self.agent(identity)]})
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(json.loads(stdout)["agents"][0]["agent_session"], {
            "agent": "omo", "kind": "id", "value": "one"
        })

    def test_retired_and_unknown_modes_fail_closed_even_when_disabled(self):
        for disabled in ("", "0"):
            for args in ([], ["--once"], ["--daemon"], ["--unknown"], ["--help"],
                         ["--dry-run", "--once"], ["--daemon", "--dry-run"],
                         ["--dry-run", "--unknown"], ["--dry-run", "--dry-run"]):
                with self.subTest(args=args, disabled=disabled):
                    code, stdout, stderr, calls = self.invoke(args, {}, disabled=disabled)
                    self.assertEqual(code, 2)
                    self.assertEqual(stdout, "")
                    self.assertTrue(stderr.strip())
                    self.assertEqual(calls, [])

    def test_disabled_environment_prevents_even_snapshot_access(self):
        for disabled in ("0", "false", "off", "no", "FALSE", "OFF", "NO"):
            with self.subTest(disabled=disabled):
                code, stdout, stderr, calls = self.invoke(["--dry-run"], {}, disabled=disabled)
                self.assertEqual((code, stderr, calls), (0, "", []))
                self.assertEqual(json.loads(stdout), {"disabled": True})

    def test_snapshot_timeout_is_bounded_and_fails_without_retry(self):
        code, stdout, stderr, calls = self.invoke(
            ["--dry-run"], error=subprocess.TimeoutExpired(["herdr"], 10)
        )
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertTrue(stderr.strip())
        self.assertEqual(calls, [[kicker.HERDR, "api", "snapshot"]])

    def test_missing_herdr_fails_without_retry(self):
        code, stdout, stderr, calls = self.invoke(["--dry-run"], error=FileNotFoundError("missing herdr"))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertTrue(stderr.strip())
        self.assertEqual(len(calls), 1)

    def test_send_timeouts_are_impossible_because_no_send_is_attempted(self):
        for command in ("send-text", "send-keys"):
            with self.subTest(command=command):
                def run(args, **kwargs):
                    if args[1:3] == ["pane", command]:
                        raise subprocess.TimeoutExpired(args, kwargs["timeout"])
                    self.assertEqual(args[1:], ["api", "snapshot"])
                    self.assertEqual(kwargs["timeout"], 10)
                    return subprocess.CompletedProcess(args, 0, json.dumps({"agents": [self.agent()]}), "")

                with (patch.object(kicker.subprocess, "run", side_effect=run) as mocked,
                      patch.object(sys, "argv", [str(SCRIPT), "--dry-run"]),
                      patch.dict(os.environ, {"OMO_IDLE_TODO_KICK": "1"}),
                      contextlib.redirect_stdout(io.StringIO())):
                    self.assertEqual(kicker.main(), 0)
                self.assertEqual(mocked.call_count, 1)

    def test_unreadable_pane_cannot_block_other_snapshot_entries(self):
        # A pane read now fails the test outright, rather than recovering and sending to pane-2.
        self.assert_read_only([self.agent(), self.agent(pane="pane-2")])

    def test_malformed_snapshot_is_an_error_not_a_successful_empty_report(self):
        for payload in (None, [], {"result": None}, {"snapshot": []},
                        {"agents": "invalid"}, {"agents": [None]}, {"agents": ["pane-1"]},
                        {"agents": [{"agent_session": "invalid"}]},
                        {"agents": [{"agent_status": {"screen": "draft"}}]}):
            with self.subTest(payload=payload):
                code, stdout, stderr, calls = self.invoke(["--dry-run"], payload)
                self.assertEqual(code, 1)
                self.assertEqual(stdout, "")
                self.assertTrue(stderr.strip())
                self.assertEqual(len(calls), 1)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.trace = self.root / "calls.jsonl"
        self.response = self.root / "snapshot.json"
        self.response.write_text(json.dumps({"result": {"snapshot": {"agents": [{
            "pane_id": "pane-1", "agent": "omo", "agent_status": "idle",
            "agent_session": {"agent": "omo", "kind": "id", "value": "session-1"},
            "screen": "muse-spark\nTodo\n[ ] work\n❯ unsent draft", "model": "muse-spark"
        }]}}}), encoding="utf-8")
        self.fake = self.root / "herdr"
        self.fake.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "with open(os.environ['FAKE_TRACE'], 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1:] != ['api', 'snapshot']:\n"
            "    raise SystemExit(99)\n"
            "print(pathlib.Path(os.environ['FAKE_RESPONSE']).read_text(encoding='utf-8'))\n"
            "raise SystemExit(int(os.environ.get('FAKE_EXIT', '0')))\n", encoding="utf-8"
        )
        self.fake.chmod(0o755)
        self.env = dict(os.environ, HERDR_BIN=str(self.fake), OMO_IDLE_TODO_KICK="1",
                        HOME=str(self.root), FAKE_TRACE=str(self.trace), FAKE_RESPONSE=str(self.response),
                        OMO_IDLE_TODO_KICK_STATE=str(self.root / "state.json"),
                        OMO_IDLE_TODO_KICK_LOG=str(self.root / "watch.log"),
                        OMO_IDLE_TODO_KICK_PID=str(self.root / "watch.pid"))

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True, timeout=5)

    def calls(self):
        return [json.loads(line) for line in self.trace.read_text(encoding="utf-8").splitlines()]

    def test_real_cli_only_calls_snapshot_and_never_writes_state(self):
        before = set(self.root.iterdir())
        result = self.cli("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls(), [["api", "snapshot"]])
        self.assertEqual(json.loads(result.stdout), {"agents": [{
            "pane_id": "pane-1", "agent": "omo", "agent_status": "idle",
            "agent_session": {"agent": "omo", "kind": "id", "value": "session-1"}
        }]})
        self.assertEqual(set(self.root.iterdir()) - before, {self.trace})

    def test_real_cli_invalid_json_fails_without_fallback(self):
        self.response.write_text("{", encoding="utf-8")
        result = self.cli("--dry-run")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.strip())
        self.assertEqual(self.calls(), [["api", "snapshot"]])

    def test_real_cli_failed_snapshot_is_not_used(self):
        self.env["FAKE_EXIT"] = "7"
        result = self.cli("--dry-run")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertTrue(result.stderr.strip())
        self.assertEqual(self.calls(), [["api", "snapshot"]])


if __name__ == "__main__":
    unittest.main()
