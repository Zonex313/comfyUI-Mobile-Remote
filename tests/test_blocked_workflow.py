"""未保存的工作流应被拒收/清理；手机列表只显示电脑端打开着的工作流。"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_purge_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def _write(root: Path, name: str, filename: str, source: str = "") -> None:
    payload = {"id": filename[:20], "name": name, "prompt": {}, "source": source}
    (root / filename).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


class BlockedWorkflowTests(unittest.TestCase):
    def test_name_matching(self):
        for value in ("Unsaved Workflow", "unsaved workflow (2)", "my Unsaved  Workflow copy", "UNSAVED WORKFLOW"):
            self.assertTrue(server._blocked_workflow_name(value), value)
        for value in ("Krea-2_turbo", "z-image_turbo", "", None, "工作流"):
            self.assertFalse(server._blocked_workflow_name(value), value)

    def test_purge_removes_only_blocked_records(self):
        with tempfile.TemporaryDirectory(prefix="purge-") as tmp:
            root = Path(tmp)
            _write(root, "Unsaved Workflow", "a" * 20 + ".json")
            _write(root, "Unsaved Workflow (2)", "b" * 20 + ".json")
            _write(root, "Krea-2_turbo", "c" * 20 + ".json")
            with mock.patch.object(server, "WORKFLOW_ROOT", root):
                removed = server._purge_blocked_records()
            self.assertEqual(removed, 2)
            self.assertEqual([p.stem for p in root.glob("*.json")], ["c" * 20])

    def test_list_filters_by_open_sources(self):
        with tempfile.TemporaryDirectory(prefix="list-") as tmp:
            root = Path(tmp)
            _write(root, "Unsaved Workflow", "d" * 20 + ".json", "workflows/Unsaved Workflow.json")
            _write(root, "A", "e" * 20 + ".json", "workflows/A.json")
            _write(root, "B", "f" * 20 + ".json", "workflows/B.json")
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: {"workflows/A.json", "workflows/B.json"}
            ):
                records = server._list_records()
            self.assertEqual(sorted(item["name"] for item in records), ["A", "B"])
            # 关掉 B 之后只剩 A；全关就空
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: {"workflows/A.json"}
            ):
                self.assertEqual([item["name"] for item in server._list_records()], ["A"])
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: None
            ):
                self.assertEqual(server._list_records(), [])
            self.assertEqual(len(list(root.glob("*.json"))), 2)

    def test_open_sources_marker_ttl(self):
        with tempfile.TemporaryDirectory(prefix="ttl-") as tmp:
            marker = Path(tmp) / "open.json"
            marker.write_text(json.dumps({"sources": ["a"], "at": 0}), encoding="utf-8")
            with mock.patch.object(server, "ACTIVE_WORKFLOW_PATH", marker):
                self.assertIsNone(server._open_workflow_sources())
            marker.write_text(
                json.dumps({"sources": ["a", "b"], "at": int(server.time.time() * 1000)}), encoding="utf-8"
            )
            with mock.patch.object(server, "ACTIVE_WORKFLOW_PATH", marker):
                self.assertEqual(server._open_workflow_sources(), {"a", "b"})

    def test_remember_open_source_keeps_existing_entries(self):
        with tempfile.TemporaryDirectory(prefix="remember-") as tmp:
            marker = Path(tmp) / "open.json"
            marker.write_text(
                json.dumps({"sources": ["a"], "at": int(server.time.time() * 1000)}), encoding="utf-8"
            )
            with mock.patch.object(server, "ACTIVE_WORKFLOW_PATH", marker):
                server._remember_open_source("b")
                self.assertEqual(server._open_workflow_sources(), {"a", "b"})


if __name__ == "__main__":
    unittest.main()
