import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "idle_todo_kick", Path(__file__).resolve().parents[1] / "idle-todo-kick.py"
)
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
        for name, value in (
            ("SESSIONS_DIR", self.sessions),
            ("STATE_PATH", self.root / "state.json"),
            ("LOG_PATH", self.root / "watch.log"),
            ("COOLDOWN_MS", 90000),
            ("MAX_KICKS", 6),
        ):
            mock = patch.object(kicker, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def session(
        self, session_id="one", cwd=None, when="a PR URL is available", mtime=100
    ):
        cwd = self.cwd if cwd is None else cwd
        folder = self.sessions / ("--" + cwd.replace("/", "-").strip("-") + "--")
        folder.mkdir(exist_ok=True)
        path = folder / f"2026-09-07T00-00-00-000Z_{session_id}.jsonl"
        entries = [
            {"type": "session", "id": session_id, "cwd": cwd},
            {
                "type": "custom",
                "customType": "muse-watch.contract",
                "data": {"when": when},
            },
        ]
        path.write_text(
            "".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8"
        )
        os.utime(path, (mtime, mtime))
        return path

    def agent(self, identity=None, pane="pane-1"):
        agent = {
            "agent": "omo",
            "agent_status": "idle",
            "pane_id": pane,
            "cwd": self.cwd,
        }
        if identity is not None:
            agent["agent_session"] = identity
        return agent

    def run_tick(self, agents, texts=None):
        texts = texts or {agent["pane_id"]: "muse-spark\n❯" for agent in agents}

        def herdr(*args):
            if args == ("api", "snapshot"):
                return json.dumps({"result": {"snapshot": {"agents": agents}}})
            if args[:2] == ("pane", "read"):
                value = texts[args[-1]]
                if isinstance(value, Exception):
                    raise value
                return value
            raise AssertionError(f"unexpected Herdr command: {args}")

        with (
            patch.object(kicker, "herdr", side_effect=herdr),
            patch.object(kicker, "kick") as kick,
            patch.object(kicker.time, "time", return_value=1000),
        ):
            state = kicker.tick({})
        return state, kick

    def test_negated_pr_contracts_do_not_kick(self):
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
                state, kick = self.run_tick([self.agent()])
                self.assertEqual(state, {})
                kick.assert_not_called()

    def test_positive_pr_contract_still_kicks(self):
        for when in (
            "a PR URL is available",
            "tests have no failures and a PR URL is available",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                state, kick = self.run_tick([self.agent()])
                self.assertEqual(state["pane-1"]["kicks"], 1)
                self.assertEqual(kick.call_args.args[0], "pane-1")
                self.assertEqual(kick.call_args.args[2], "contract")

    def test_positive_pr_requirement_survives_separate_negation(self):
        for when in (
            "the PR URL is available without creating a PR",
            "the PR URL is available without opening another PR",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                state, kick = self.run_tick([self.agent()])
                kick.assert_called_once()
                self.assertEqual(kick.call_args.args[2], "contract")
                self.assertEqual(state["pane-1"]["kicks"], 1)

    def test_negated_pr_articles_and_urls_do_not_kick(self):
        for when in (
            "the changes are committed without opening another PR",
            "the changes are committed without an PR URL",
            "the changes are committed with no PR URL",
            "the changes are committed; a PR URL is not required",
        ):
            with self.subTest(when=when):
                self.session(when=when)
                state, kick = self.run_tick([self.agent()])
                self.assertEqual(state, {})
                kick.assert_not_called()

    def test_assistant_negated_contract_does_not_kick(self):
        path = self.session()
        with path.open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "I'll stop when the goal is met and committed with no PR/merge.",
                                }
                            ],
                        },
                    }
                )
                + "\n"
            )
        self.run_tick([self.agent()])[1].assert_not_called()

    def test_satisfied_and_user_wait_contracts_do_not_kick(self):
        path = self.session()
        with path.open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "role": "assistant",
                        "content": "https://github.com/org/repo/pull/42",
                    }
                )
                + "\n"
            )
        self.run_tick([self.agent()])[1].assert_not_called()
        self.session(when="you confirm the PR")
        self.run_tick([self.agent()])[1].assert_not_called()

    def test_same_basename_is_not_a_cwd_match(self):
        self.session(cwd="/other/project")
        self.assertIsNone(kicker.session_jsonl_for_cwd(self.cwd))
        self.run_tick([self.agent()])[1].assert_not_called()

    def test_cwd_prefix_is_not_a_cwd_match(self):
        self.session(cwd=self.cwd + "-other")
        self.assertIsNone(kicker.session_jsonl_for_cwd(self.cwd))

    def test_newest_same_cwd_session_is_ambiguous(self):
        self.session("old", when="tests pass", mtime=100)
        self.session("new", mtime=200)
        self.assertIsNone(kicker.session_jsonl_for_cwd(self.cwd))
        self.run_tick([self.agent(), self.agent(pane="pane-2")])[1].assert_not_called()

    def test_unique_exact_cwd_session_is_supported(self):
        path = self.session()
        self.assertEqual(kicker.session_jsonl_for_cwd(self.cwd), path)

    def test_exact_session_identity_overrides_newest(self):
        old = self.session("old", mtime=100)
        self.session("new", when="tests pass", mtime=200)
        for kind, value in (("id", "old"), ("path", str(old))):
            with self.subTest(kind=kind):
                state, kick = self.run_tick(
                    [self.agent({"agent": "omo", "kind": kind, "value": value})]
                )
                self.assertEqual(state["pane-1"]["kicks"], 1)
                kick.assert_called_once()

    def test_missing_or_foreign_identity_never_falls_back(self):
        self.session()
        for identity in (
            {"agent": "omo", "kind": "id", "value": "missing"},
            {"agent": "omo", "kind": "path", "value": str(self.root / "missing.jsonl")},
            {"agent": "claude", "kind": "id", "value": "one"},
            {"agent": "omo", "kind": "unknown", "value": "one"},
        ):
            with self.subTest(identity=identity):
                self.run_tick([self.agent(identity)])[1].assert_not_called()

    def test_duplicate_session_id_is_ambiguous(self):
        self.session()
        self.session(cwd="/other/project")
        self.run_tick([self.agent({"agent": "omo", "kind": "id", "value": "one"})])[
            1
        ].assert_not_called()

    def test_id_requires_matching_session_header(self):
        path = self.session("wrong")
        path.rename(path.with_name(path.name.replace("_wrong.jsonl", "_one.jsonl")))
        self.run_tick([self.agent({"agent": "omo", "kind": "id", "value": "one"})])[
            1
        ].assert_not_called()

    def test_unreadable_candidate_does_not_make_fallback_unique(self):
        self.session("one")
        self.session("two").write_text("{", encoding="utf-8")
        with patch.object(kicker, "log") as log:
            self.assertIsNone(kicker.session_jsonl_for_cwd(self.cwd))
        log.assert_called_once()

    def test_todos_still_kick_with_ambiguous_sessions(self):
        self.session("one")
        self.session("two")
        state, kick = self.run_tick(
            [self.agent()], {"pane-1": "muse-spark\nTodo\n[ ] finish implementation\n❯"}
        )
        self.assertEqual(state["pane-1"]["kicks"], 1)
        self.assertEqual(kick.call_args.args[2], "todos")

    def test_dry_run_uses_exact_session_identity(self):
        old = self.session("old", when="tests pass", mtime=100)
        self.session("new", mtime=200)
        with (
            patch.object(
                kicker,
                "idle_omo_panes",
                return_value=[
                    self.agent({"agent": "omo", "kind": "path", "value": str(old)})
                ],
            ),
            patch.object(kicker, "pane_text", return_value="muse-spark\n❯"),
            patch.object(kicker, "log") as log,
            patch.object(kicker, "enabled", return_value=True),
            patch.object(sys, "argv", ["idle-todo-kick.py", "--dry-run"]),
        ):
            self.assertEqual(kicker.main(), 0)
        self.assertIn("contract=[]", log.call_args.args[0])

    def test_all_herdr_commands_have_a_timeout(self):
        commands = (
            ("api", "snapshot"),
            ("pane", "read", "pane-1"),
            ("pane", "send-text", "pane-1", "text"),
            ("pane", "send-keys", "pane-1", "Enter"),
        )
        for args in commands:
            with (
                self.subTest(args=args),
                patch.object(
                    kicker.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(args, 0, "ok", ""),
                ) as run,
            ):
                self.assertEqual(kicker.herdr(*args), "ok")
                self.assertGreater(run.call_args.kwargs.get("timeout", 0), 0)
                self.assertLessEqual(run.call_args.kwargs["timeout"], 30)

    def test_herdr_timeout_is_reported_as_runtime_error(self):
        with patch.object(
            kicker.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["herdr"], 10),
        ):
            with self.assertRaises(RuntimeError) as raised:
                kicker.herdr("api", "snapshot")
        self.assertIsInstance(raised.exception.__cause__, subprocess.TimeoutExpired)

    def test_send_timeout_does_not_record_a_successful_kick(self):
        for command in ("send-text", "send-keys"):
            with self.subTest(command=command):

                def run(args, **kwargs):
                    if args[1:3] == ["pane", command]:
                        raise subprocess.TimeoutExpired(args, kwargs["timeout"])
                    return subprocess.CompletedProcess(args, 0, "", "")

                with (
                    patch.object(kicker, "idle_omo_panes", return_value=[self.agent()]),
                    patch.object(
                        kicker,
                        "pane_text",
                        return_value="muse-spark\nTodo\n[ ] finish implementation\n❯",
                    ),
                    patch.object(kicker.subprocess, "run", side_effect=run),
                    patch.object(kicker.time, "time", return_value=1000),
                    patch.object(kicker, "log") as log,
                ):
                    self.assertEqual(kicker.tick({}), {})
                log.assert_called_once()

    def test_read_timeout_does_not_block_other_panes(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[1:3] == ["api", "snapshot"]:
                output = json.dumps(
                    {"agents": [self.agent(), self.agent(pane="pane-2")]}
                )
            elif args[1:3] == ["pane", "read"]:
                if args[-1] == "pane-1":
                    raise subprocess.TimeoutExpired(args, kwargs.get("timeout", 10))
                output = "muse-spark\nTodo\n[ ] finish implementation\n❯"
            else:
                output = ""
            return subprocess.CompletedProcess(args, 0, output, "")

        with (
            patch.object(kicker.subprocess, "run", side_effect=run),
            patch.object(kicker.time, "time", return_value=1000),
            patch.object(kicker, "log") as log,
        ):
            state = kicker.tick({})
        self.assertNotIn("pane-1", state)
        self.assertEqual(state["pane-2"]["kicks"], 1)
        self.assertTrue(any(call[1:3] == ["pane", "send-keys"] for call in calls))
        self.assertTrue(
            any("skip pane-1 read:" in call.args[0] for call in log.call_args_list)
        )


if __name__ == "__main__":
    unittest.main()
