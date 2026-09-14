"""自制节点的控件不能出现在手机端字段列表里（手机操作手感必须保持不变）。"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_tag_fields_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class TagNodeFieldTests(unittest.TestCase):
    def test_tag_mode_switch_is_hidden_from_the_phone(self):
        prompt = {
            "5": {
                "class_type": "MobileTagCLIPTextEncode",
                "inputs": {"text": "海边写真", "clip": ["4", 0], "标签模式": True, "每次随机": True},
            }
        }
        fields = server._infer_fields(prompt)
        by_input = {field["input"]: field for field in fields}
        self.assertEqual(set(by_input), {"text"})
        self.assertEqual(by_input["text"]["id"], "5::text")
        self.assertEqual(by_input["text"]["kind"], "textarea")
        self.assertEqual(by_input["text"]["group"], "basic")

    def test_other_nodes_still_expose_their_own_booleans(self):
        prompt = {
            "6": {
                "class_type": "SomeOtherNode",
                "inputs": {"tag_mode": True, "text": "hi"},
            }
        }
        fields = {field["input"] for field in server._infer_fields(prompt)}
        self.assertEqual(fields, {"tag_mode", "text"})

    def test_hidden_input_table_only_covers_the_tag_node(self):
        self.assertEqual(
            set(server.NODE_HIDDEN_INPUTS),
            {"MobileTagCLIPTextEncode"},
        )
        self.assertEqual(
            set(server.NODE_HIDDEN_INPUTS["MobileTagCLIPTextEncode"]),
            {"标签模式", "每次随机", "tag_mode"},
        )


if __name__ == "__main__":
    unittest.main()
