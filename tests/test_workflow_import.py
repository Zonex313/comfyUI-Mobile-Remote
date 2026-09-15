"""导入常驻工作流：手机列表的放行规则、覆盖时保住常驻标记、载荷校验。"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_import_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

PROMPT = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _write(root: Path, filename: str, *, name: str, source: str, pinned: bool = False, library_path: str = "") -> None:
    record = {
        "schema": 1,
        "id": filename[:20],
        "name": name,
        "source": source,
        "synced_at": 5,
        "prompt": PROMPT,
        "workflow": {},
    }
    if pinned:
        record["pinned"] = True
        record["pinned_at"] = 1700000000000
    if library_path:
        record["library_path"] = library_path
    (root / filename).write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def _payload(**overrides):
    payload = {
        "name": "Krea-2_turbo",
        "source": "workflows/全部/图像/图像生成/Krea-2/Krea-2_turbo.json",
        "library_path": "全部/图像/图像生成/Krea-2/Krea-2_turbo.json",
        "prompt": {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}},
        "workflow": {"id": "c9bd5b4f-3835-4a09-b47f-374fe4b02bbe", "nodes": []},
    }
    payload.update(overrides)
    return payload


class PinnedListingTests(unittest.TestCase):
    def test_pinned_record_survives_every_tab_being_closed(self):
        with tempfile.TemporaryDirectory(prefix="import-list-") as tmp:
            root = Path(tmp)
            _write(root, "a" * 20 + ".json", name="常驻的", source="workflows/常驻.json", pinned=True)
            _write(root, "b" * 20 + ".json", name="打开才有的", source="workflows/临时.json")
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: None
            ):
                records = server._list_records()
            self.assertEqual([item["name"] for item in records], ["常驻的"])
            self.assertTrue(records[0]["pinned"])

    def test_pinned_sorts_first_and_unpinned_still_follows_open_tabs(self):
        with tempfile.TemporaryDirectory(prefix="import-order-") as tmp:
            root = Path(tmp)
            _write(root, "a" * 20 + ".json", name="常驻的", source="workflows/常驻.json", pinned=True)
            _write(root, "b" * 20 + ".json", name="开着的", source="workflows/开着的.json")
            _write(root, "c" * 20 + ".json", name="关着的", source="workflows/关着的.json")
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: {"workflows/开着的.json"}
            ):
                records = server._list_records()
            self.assertEqual([item["name"] for item in records], ["常驻的", "开着的"])

    def test_include_hidden_lists_everything_with_flags(self):
        with tempfile.TemporaryDirectory(prefix="import-all-") as tmp:
            root = Path(tmp)
            _write(
                root,
                "a" * 20 + ".json",
                name="导入过的",
                source="workflows/导入过的.json",
                pinned=True,
                library_path="全部/导入过的.json",
            )
            _write(root, "b" * 20 + ".json", name="没导入的", source="workflows/没导入的.json")
            with mock.patch.object(server, "WORKFLOW_ROOT", root), mock.patch.object(
                server, "_open_workflow_sources", lambda: None
            ):
                records = server._list_records(include_hidden=True)
            by_name = {item["name"]: item for item in records}
            self.assertEqual(sorted(by_name), ["导入过的", "没导入的"])
            self.assertTrue(by_name["导入过的"]["pinned"])
            self.assertEqual(by_name["导入过的"]["library_path"], "全部/导入过的.json")
            self.assertFalse(by_name["没导入的"]["pinned"])


class CarryOverTests(unittest.TestCase):
    def test_sync_keeps_pinned_marker_and_library_path(self):
        with tempfile.TemporaryDirectory(prefix="import-keep-") as tmp:
            root = Path(tmp)
            record, error = server._record_from_payload(_payload())
            self.assertEqual(error, "")
            _write(
                root,
                f"{record['id']}.json",
                name=record["name"],
                source=record["source"],
                pinned=True,
                library_path="全部/图像/图像生成/Krea-2/Krea-2_turbo.json",
            )
            with mock.patch.object(server, "WORKFLOW_ROOT", root):
                server._carry_over_flags(record)
            self.assertTrue(record["pinned"])
            self.assertEqual(record["pinned_at"], 1700000000000)
            self.assertEqual(record["library_path"], "全部/图像/图像生成/Krea-2/Krea-2_turbo.json")

    def test_sync_does_not_invent_pinned_marker(self):
        with tempfile.TemporaryDirectory(prefix="import-nokeep-") as tmp:
            root = Path(tmp)
            # 自动同步不会带 library_path，只有导入才带
            record, _ = server._record_from_payload(_payload(library_path=""))
            _write(root, f"{record['id']}.json", name=record["name"], source=record["source"])
            with mock.patch.object(server, "WORKFLOW_ROOT", root):
                server._carry_over_flags(record)
            self.assertNotIn("pinned", record)
            self.assertNotIn("library_path", record)


class PayloadTests(unittest.TestCase):
    def test_identity_follows_the_same_rules_as_auto_sync(self):
        # 工作流自带 id 优先：先导入、之后在电脑端打开，会更新同一条记录而不是新增一条
        by_id, _ = server._record_from_payload(_payload())
        self.assertEqual(by_id["id"], hashlib.sha256(_payload()["workflow"]["id"].encode()).hexdigest()[:20])
        # 没有 id 就用 source
        no_id, _ = server._record_from_payload(_payload(workflow={"nodes": []}))
        self.assertEqual(no_id["id"], hashlib.sha256(_payload()["source"].encode()).hexdigest()[:20])
        # 都没有才退回名字
        bare, _ = server._record_from_payload(_payload(workflow={}, source=""))
        self.assertEqual(bare["id"], hashlib.sha256(_payload()["name"].encode()).hexdigest()[:20])
        self.assertEqual(bare["source"], _payload()["name"])

    def test_rejects_prompts_the_phone_cannot_run(self):
        self.assertEqual(server._record_from_payload(_payload(prompt={}))[1], "当前工作流没有可执行节点")
        self.assertEqual(server._record_from_payload(_payload(prompt="x"))[1], "当前工作流没有可执行节点")
        bad = _payload(prompt={"1": {"inputs": {}}})
        self.assertEqual(server._record_from_payload(bad)[1], "需要 ComfyUI API 格式的工作流")
        record, error = server._record_from_payload(_payload(workflow="nope"))
        self.assertEqual(error, "")
        self.assertEqual(record["workflow"], {})

    def test_name_and_library_path_are_sanitized(self):
        record, _ = server._record_from_payload(
            _payload(name="a\u0000b\n" + "长" * 200, library_path="全部/x\u0007y.json")
        )
        self.assertNotIn("\u0000", record["name"])
        self.assertNotIn("\n", record["name"])
        self.assertEqual(len(record["name"]), 120)
        self.assertEqual(record["library_path"], "全部/xy.json")
        blank, _ = server._record_from_payload(_payload(name="   ", library_path=""))
        self.assertEqual(blank["name"], "当前工作流")
        self.assertNotIn("library_path", blank)


if __name__ == "__main__":
    unittest.main(verbosity=2)
