"""Isolated tests for the plugin-only live progress snapshot.

Run without importing ComfyUI or starting a server:
    python.exe -B tests/test_progress_snapshot.py
"""
from __future__ import annotations

import asyncio
import importlib.util
import math
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace


sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).resolve().parents[1] / "progress_snapshot.py"
SPEC = importlib.util.spec_from_file_location("mobile_progress_snapshot_under_test", MODULE_PATH)
progress_snapshot = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(progress_snapshot)

SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SERVER_SPEC = importlib.util.spec_from_file_location("mobile_server_under_test", SERVER_PATH)
mobile_server = importlib.util.module_from_spec(SERVER_SPEC)
assert SERVER_SPEC.loader is not None
SERVER_SPEC.loader.exec_module(mobile_server)


class Queue:
    def __init__(self, running=(), pending=()):
        self.running = list(running)
        self.pending = list(pending)
        self.calls = 0

    def get_current_queue_volatile(self):
        self.calls += 1
        return self.running, self.pending


class BrokenQueue:
    def get_current_queue_volatile(self):
        raise RuntimeError("queue changed")


class DynPrompt:
    def __init__(self, display_ids=None, parent_ids=None):
        self.display_ids = display_ids or {}
        self.parent_ids = parent_ids or {}

    def get_display_node_id(self, node_id):
        return self.display_ids.get(node_id, node_id)

    def get_parent_node_id(self, node_id):
        return self.parent_ids.get(node_id)


class Registry:
    def __init__(self, prompt_id, nodes, display_ids=None, parent_ids=None):
        self.prompt_id = prompt_id
        self.nodes = nodes
        self.dynprompt = DynPrompt(display_ids, parent_ids)


def item(prompt_id, extra=None):
    extra_data = {"create_time": 1_700_000_000_000, "mobile_remote": {"workflow_name": "手机工作流"}}
    if extra:
        extra_data.update(extra)
    # Prompt, sensitive data, and arbitrary graph data must never appear in output.
    return (0, prompt_id, {"secret_prompt": "do not expose"}, extra_data, [], {"token": "do not expose"})


class ProgressSnapshotTests(unittest.TestCase):
    def test_idle_queue_returns_null_job_without_importing_registry(self):
        class NoRegistryModule:
            _progress_state = None
            global_progress_registry = None

            @staticmethod
            def get_progress_state():
                raise AssertionError("idle snapshots must not create a registry")

        queue = Queue(pending=[item("pending")])
        result = progress_snapshot.snapshot_progress(queue, NoRegistryModule)

        self.assertEqual(result["prompt_id"], None)
        self.assertIsNone(result["active_job"])
        self.assertEqual(result["nodes"], {})
        self.assertEqual(result["pending_count"], 1)
        self.assertEqual(result["running_count"], 0)
        self.assertEqual(result["running_ids"], [])
        self.assertEqual(queue.calls, 1)

    def test_matching_registry_copies_running_finite_nodes_only(self):
        registry = Registry(
            "running-id",
            {
                "1": {"state": "running", "value": 2, "max": 10},
                "2": {"state": SimpleNamespace(value="pending"), "value": 0, "max": 1},
                "3": {"state": "finished", "value": 10, "max": 10},
                "4": {"state": "error", "value": 1, "max": 10},
                "5": {"state": "running", "value": math.nan, "max": 10},
                "6": {"state": "running", "value": 1, "max": math.inf},
                "7": {"state": "paused", "value": 1, "max": 3},
            },
            {"1": "display-1", "2": "display-2", "7": None},
            {"1": "parent-1", "2": "parent-2", "7": "parent-7"},
        )
        module = SimpleNamespace(_progress_state=None, global_progress_registry=registry)
        queue = Queue(running=[item("running-id", {"mobile_remote": {"workflow_name": "测试流程"}})])

        result = progress_snapshot.snapshot_progress(queue, module)

        self.assertEqual(result["prompt_id"], "running-id")
        self.assertEqual(result["active_job"], {
            "id": "running-id",
            "status": "in_progress",
            "workflow_name": "测试流程",
            "create_time": 1_700_000_000_000,
        })
        self.assertEqual(result["running_count"], 1)
        self.assertEqual(result["running_ids"], ["running-id"])
        self.assertEqual(result["nodes"]["1"], {
            "node_id": "1",
            "display_node_id": "display-1",
            "parent_node_id": "parent-1",
            "value": 2,
            "max": 10,
            "state": "running",
        })
        self.assertNotIn("2", result["nodes"])
        self.assertEqual(result["nodes"].get("7", {}).get("display_node_id"), None)
        self.assertNotIn("3", result["nodes"])
        self.assertNotIn("4", result["nodes"])
        self.assertNotIn("5", result["nodes"])
        self.assertNotIn("6", result["nodes"])
        self.assertTrue(all(math.isfinite(node["value"]) and math.isfinite(node["max"])
                            for node in result["nodes"].values()))

        registry.nodes["1"]["value"] = 9
        self.assertEqual(result["nodes"]["1"]["value"], 2)

    def test_matching_uses_private_progress_state_shape_first(self):
        private = Registry("private-id", {"1": {"state": "running", "value": 0, "max": 1}})
        public = Registry("other-id", {"2": {"state": "running", "value": 4, "max": 5}})
        module = SimpleNamespace(_progress_state=private, global_progress_registry=public)
        result = progress_snapshot.snapshot_progress(Queue(running=[item("private-id")]), module)

        self.assertEqual(result["prompt_id"], "private-id")
        self.assertEqual(result["nodes"]["1"]["value"], 0)
        self.assertNotIn("2", result["nodes"])

    def test_registry_mismatch_reports_live_job_but_no_node_state(self):
        registry = Registry("different-id", {"1": {"state": "running", "value": 4, "max": 5}})
        module = SimpleNamespace(_progress_state=None, global_progress_registry=registry)
        result = progress_snapshot.snapshot_progress(Queue(running=[item("live-id")]), module)

        self.assertEqual(result["prompt_id"], "live-id")
        self.assertEqual(result["active_job"]["status"], "in_progress")
        self.assertEqual(result["nodes"], {})

    def test_missing_registry_keeps_running_job_and_does_not_call_getter(self):
        class OldProgressModule:
            @staticmethod
            def get_progress_state():
                raise AssertionError("get_progress_state must never be called")

        result = progress_snapshot.snapshot_progress(Queue(running=[item("old-id")]), OldProgressModule)

        self.assertEqual(result["prompt_id"], "old-id")
        self.assertEqual(result["nodes"], {})
        self.assertEqual(result["active_job"]["workflow_name"], "手机工作流")

    def test_only_running_queue_items_can_be_active_and_metadata_is_allowlisted(self):
        queue = Queue(
            running=[item("running-id", {
                "create_time": "2024-01-02T03:04:05Z",
                "mobile_remote": {
                    "workflow_name": "允许名称",
                    "values": {"prompt": "secret"},
                    "api_key": "secret",
                },
                "prompt": "secret graph",
            })],
            pending=[item("pending-id", {"mobile_remote": {"workflow_name": "不应选中"}})],
        )
        result = progress_snapshot.snapshot_progress(queue, None)

        self.assertEqual(result["prompt_id"], "running-id")
        self.assertEqual(result["active_job"]["workflow_name"], "允许名称")
        self.assertEqual(result["active_job"]["create_time"], "2024-01-02T03:04:05Z")
        self.assertNotIn("prompt", result)
        self.assertNotIn("values", result)
        self.assertNotIn("api_key", result)
        self.assertNotIn("pending-id", result["running_ids"])

    def test_queue_failures_are_explicit_unavailable_errors(self):
        with self.assertRaises(progress_snapshot.ProgressSnapshotUnavailable):
            progress_snapshot.snapshot_progress(BrokenQueue(), None)

    def test_bad_queue_items_are_ignored_without_exposing_arbitrary_data(self):
        registry = Registry("good-id", {})
        module = SimpleNamespace(_progress_state=registry)
        queue = Queue(running=[None, (0,), (0, {"bad": "id"}), item("good-id")])
        result = progress_snapshot.snapshot_progress(queue, module)

        self.assertEqual(result["prompt_id"], "good-id")
        self.assertEqual(result["running_count"], 4)
        self.assertEqual(result["running_ids"], ["good-id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
