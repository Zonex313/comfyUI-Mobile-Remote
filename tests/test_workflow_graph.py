"""「高级」页的节点图数据：顺序、分组、连线关系。"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_graph_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def native(node_id, x, y, size=(210, 100)):
    return {"id": int(node_id), "pos": [x, y], "size": list(size)}


class WorkflowGraphTests(unittest.TestCase):
    def setUp(self):
        self.prompt = {
            "4": node("CheckpointLoaderSimple", ckpt_name="a.safetensors"),
            "5": node("CLIPTextEncode", text="正向", clip=["4", 1]),
            "6": node("CLIPTextEncode", text="反向", clip=["4", 2]),
            "7": node("KSampler", positive=["5", 0], negative=["6", 0], seed=1),
        }
        self.fields = server._infer_fields(self.prompt)
        self.workflow = {
            "nodes": [native("4", 0, 0), native("5", 400, 0), native("6", 400, 300), native("7", 800, 150)],
            "groups": [
                {"title": "文本", "bounding": [350, -50, 300, 450], "color": "#3f789e"},
                {"title": "内层", "bounding": [380, 250, 200, 200]},
            ],
        }

    def test_nodes_are_ordered_by_canvas_position(self):
        graph = server._workflow_graph(self.prompt, self.workflow, self.fields)
        self.assertEqual([n["id"] for n in graph["nodes"]], ["4", "5", "7", "6"])

    def test_links_are_exposed_per_input(self):
        graph = server._workflow_graph(self.prompt, self.workflow, self.fields)
        by_id = {n["id"]: n for n in graph["nodes"]}
        self.assertEqual(by_id["5"]["links"], [{"name": "clip", "node": "4", "slot": 1}])
        self.assertEqual([l["node"] for l in by_id["7"]["links"]], ["5", "6"])
        self.assertEqual(by_id["4"]["links"], [])

    def test_innermost_group_wins(self):
        graph = server._workflow_graph(self.prompt, self.workflow, self.fields)
        by_id = {n["id"]: n for n in graph["nodes"]}
        # 节点 6 同时落在「文本」和「内层」里，取面积更小的内层
        self.assertEqual(by_id["6"]["group"], "内层")
        self.assertEqual(by_id["5"]["group"], "文本")
        self.assertEqual(by_id["4"]["group"], "")
        self.assertEqual([g["title"] for g in graph["groups"]], ["文本", "内层"])

    def test_editable_fields_are_mapped_to_their_node(self):
        graph = server._workflow_graph(self.prompt, self.workflow, self.fields)
        by_id = {n["id"]: n for n in graph["nodes"]}
        self.assertTrue(by_id["5"]["has_editable"])
        self.assertIn("5::text", by_id["5"]["field_ids"])
        self.assertNotIn("5::text", by_id["7"]["field_ids"])

    def test_missing_native_graph_still_lists_nodes(self):
        graph = server._workflow_graph(self.prompt, None, self.fields)
        self.assertEqual(len(graph["nodes"]), 4)
        self.assertEqual(graph["groups"], [])
        self.assertIsNone(graph["nodes"][0]["pos"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
