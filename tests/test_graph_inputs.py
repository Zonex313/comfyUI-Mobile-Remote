"""「高级」页要按画布节点 1:1 呈现：服务端给的输入 schema 与提交校验。

不需要 ComfyUI 运行时：节点类用注入的假 `nodes` 模块顶替（`_input_specs` 是运行时才 import nodes 的）。
覆盖：
- graph.nodes[].inputs 的数量/顺序/类型/候选值/范围/多行/连线；
- 节点类查不到时不报错、退化成 STRING；
- INPUT_TYPES() 按 class_type 缓存（计数假类只被调一次）；
- 提交时能写入 fields 之外的输入、拒绝不存在的节点/输入、INT 夹取与类型兜底。

跑法：
    python.exe -B tests/test_graph_inputs.py
"""
from __future__ import annotations

import copy
import importlib.util
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_inputs_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class FakeLoader:
    """老式 COMBO 写法：候选值就是第一个元素里的 list。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"ckpt_name": (["a.safetensors", "b.safetensors"],)}}


class FakeSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {}),
                "seed": ("INT", {"default": 1, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "步数": ("INT", {"default": 20, "min": 1, "max": 100, "step": 2}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.5}),
                "sampler_name": (["euler", "dpmpp_2m"],),
                "新式下拉": ("COMBO", {"options": ["sd15", "sdxl"]}),
            },
            "optional": {
                "text": ("STRING", {"multiline": True}),
                "说明": ("STRING", {}),
                "开关": ("BOOLEAN", {"default": False}),
            },
        }


class FakeTagEncode:
    """自制「CLIP文本编码丨随机标签」的输入形状（NODE_HIDDEN_INPUTS 认的就是这个类名）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {}),
                "text": ("STRING", {"multiline": True}),
                "标签模式": ("BOOLEAN", {"default": False}),
                "每次随机": ("BOOLEAN", {"default": True}),
            }
        }


class LaterNode:
    """测试「类事后才登记」用的小节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"amount": ("INT", {"min": 0, "max": 10})}}


class SeedNode:
    """带种子模式的节点：画布上 seed 后面还有一格 control_after_generate。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 100}),
                "sampler_name": (["euler", "dpmpp_2m"],),
            },
            "optional": {"note": ("STRING", {})},
        }


def make_seed_prompt():
    return {"3": {"class_type": "SeedNode", "inputs": {"seed": 42, "steps": 20, "sampler_name": "euler", "note": ""}}}


def seed_workflow(widgets_values):
    return {"nodes": [{"id": 3, "pos": [0, 0], "size": [210, 100], "widgets_values": widgets_values}]}


NODE_CLASSES = {
    "FakeLoader": FakeLoader,
    "FakeSampler": FakeSampler,
    "MobileTagCLIPTextEncode": FakeTagEncode,
}


def counting_node_class(input_types, counter):
    """INPUT_TYPES() 调用计数的假节点类。"""

    class CountingNode:
        @classmethod
        def INPUT_TYPES(cls):
            counter["calls"] += 1
            return input_types

    return CountingNode


def make_prompt():
    return {
        "4": {"class_type": "FakeLoader", "inputs": {"ckpt_name": "a.safetensors"}},
        "5": {
            "class_type": "MobileTagCLIPTextEncode",
            "inputs": {"clip": ["4", 0], "text": "海边写真", "标签模式": True, "每次随机": False},
        },
        "6": {
            "class_type": "FakeSampler",
            "inputs": {
                "model": ["4", 0],
                "seed": 1,
                "步数": 20,
                "cfg": 7.0,
                "sampler_name": "euler",
                "新式下拉": "sd15",
                "text": "多行文本",
                "说明": "单行",
                "开关": False,
            },
        },
    }


def node_of(graph, node_id):
    return next(item for item in graph["nodes"] if item["id"] == node_id)


def entry_of(node, name):
    return next(item for item in node["inputs"] if item["name"] == name)


class GraphInputSchemaTests(unittest.TestCase):
    def setUp(self):
        server._INPUT_SPECS_CACHE.clear()
        self.nodes_mapping = dict(NODE_CLASSES)
        self.previous_nodes = sys.modules.get("nodes")
        module = types.ModuleType("nodes")
        module.NODE_CLASS_MAPPINGS = self.nodes_mapping
        sys.modules["nodes"] = module

    def tearDown(self):
        if self.previous_nodes is None:
            sys.modules.pop("nodes", None)
        else:
            sys.modules["nodes"] = self.previous_nodes

    def graph(self, prompt):
        return server._workflow_graph(prompt, None, server._infer_fields(prompt))

    def test_inputs_cover_every_key_in_prompt_order(self):
        prompt = make_prompt()
        graph = self.graph(prompt)
        # 顺序照抄 prompt（也就是画布上的槽位顺序），一个键都不能少
        self.assertEqual(
            [item["name"] for item in node_of(graph, "5")["inputs"]],
            list(prompt["5"]["inputs"]),
        )
        self.assertEqual(
            [item["name"] for item in node_of(graph, "6")["inputs"]],
            list(prompt["6"]["inputs"]),
        )

    def test_hidden_inputs_outside_fields_are_still_listed(self):
        prompt = make_prompt()
        graph = self.graph(prompt)
        names = [item["name"] for item in node_of(graph, "5")["inputs"]]
        fields = {field["input"] for field in server._infer_fields(prompt) if field["node_id"] == "5"}
        # 「标签模式」/「每次随机」在生成页被 NODE_HIDDEN_INPUTS 藏了，高级页必须能看到
        self.assertEqual(fields, {"text"})
        self.assertIn("标签模式", names)
        self.assertIn("每次随机", names)
        self.assertIs(True, entry_of(node_of(graph, "5"), "标签模式")["value"])
        self.assertEqual(entry_of(node_of(graph, "5"), "标签模式")["type"], "BOOLEAN")

    def test_combo_options_int_range_float_range_and_multiline(self):
        graph = self.graph(make_prompt())
        node6 = node_of(graph, "6")
        self.assertEqual(entry_of(node6, "sampler_name")["type"], "COMBO")
        self.assertEqual(entry_of(node6, "sampler_name")["options"], ["euler", "dpmpp_2m"])
        self.assertEqual(entry_of(node6, "新式下拉")["options"], ["sd15", "sdxl"])
        self.assertEqual(entry_of(node_of(graph, "4"), "ckpt_name")["options"], ["a.safetensors", "b.safetensors"])

        steps = entry_of(node6, "步数")
        self.assertEqual(steps["type"], "INT")
        self.assertEqual((steps["min"], steps["max"], steps["step"]), (1, 100, 2))
        self.assertEqual(steps["value"], 20)
        # seed 没有 step，就不该硬塞一个
        self.assertNotIn("step", entry_of(node6, "seed"))

        cfg = entry_of(node6, "cfg")
        self.assertEqual(cfg["type"], "FLOAT")
        self.assertEqual((cfg["min"], cfg["max"], cfg["step"]), (0.0, 30.0, 0.5))

        self.assertIs(True, entry_of(node6, "text")["multiline"])
        self.assertEqual(entry_of(node6, "text")["type"], "STRING")
        self.assertNotIn("multiline", entry_of(node6, "说明"))
        self.assertEqual(entry_of(node6, "说明")["value"], "单行")
        # 不认识的基础类型原样透传，不瞎猜
        self.assertEqual(entry_of(node6, "model")["type"], "MODEL")

    def test_linked_input_reports_link_and_drops_value(self):
        graph = self.graph(make_prompt())
        clip = entry_of(node_of(graph, "5"), "clip")
        self.assertEqual(clip["link"], {"node": "4", "slot": 0})
        self.assertIsNone(clip["value"])
        self.assertEqual(clip["type"], "CLIP")
        model = entry_of(node_of(graph, "6"), "model")
        self.assertEqual(model["link"], {"node": "4", "slot": 0})
        self.assertIsNone(model["value"])
        # 没被连线的输入不带 link
        self.assertNotIn("link", entry_of(node_of(graph, "5"), "text"))

    def test_unknown_node_class_degrades_to_string(self):
        prompt = {"9": {"class_type": "NotRegisteredNode", "inputs": {"text": "x", "图片": None}}}
        graph = self.graph(prompt)
        for item in node_of(graph, "9")["inputs"]:
            self.assertEqual(item["type"], "STRING")
            self.assertNotIn("options", item)
            self.assertNotIn("min", item)
            self.assertNotIn("multiline", item)

    def test_input_types_is_cached_per_class_type(self):
        counter = {"calls": 0}
        self.nodes_mapping["CachedInputs"] = counting_node_class(
            {"required": {"text": ("STRING", {"multiline": True})}},
            counter,
        )
        prompt = {
            "1": {"class_type": "CachedInputs", "inputs": {"text": "a"}},
            "2": {"class_type": "CachedInputs", "inputs": {"text": "b"}},
        }
        self.graph(prompt)
        self.graph(prompt)
        server._apply_submitted_input(prompt, "1::text", "c")
        self.assertEqual(counter["calls"], 1)

    def test_unknown_class_is_not_cached_forever(self):
        prompt = {"9": {"class_type": "LaterNode", "inputs": {"amount": 5}}}
        # 类还没登记：退化成 STRING，但别把这个“空答案”缓存住
        self.assertEqual(entry_of(node_of(self.graph(prompt), "9"), "amount")["type"], "STRING")
        self.nodes_mapping["LaterNode"] = LaterNode
        amount = entry_of(node_of(self.graph(prompt), "9"), "amount")
        self.assertEqual(amount["type"], "INT")
        self.assertEqual((amount["min"], amount["max"]), (0, 10))


class SubmittedInputTests(unittest.TestCase):
    def setUp(self):
        server._INPUT_SPECS_CACHE.clear()
        self.nodes_mapping = dict(NODE_CLASSES)
        self.previous_nodes = sys.modules.get("nodes")
        module = types.ModuleType("nodes")
        module.NODE_CLASS_MAPPINGS = self.nodes_mapping
        sys.modules["nodes"] = module

    def tearDown(self):
        if self.previous_nodes is None:
            sys.modules.pop("nodes", None)
        else:
            sys.modules["nodes"] = self.previous_nodes

    def test_applies_input_that_fields_never_expose(self):
        prompt = make_prompt()
        fields = {field["id"] for field in server._infer_fields(prompt)}
        self.assertNotIn("5::标签模式", fields)

        applied, value = server._apply_submitted_input(prompt, "5::标签模式", True)
        self.assertTrue(applied)
        self.assertIs(True, value)
        self.assertIs(True, prompt["5"]["inputs"]["标签模式"])
        # 手机端传字符串也要认
        applied, value = server._apply_submitted_input(prompt, "5::标签模式", "false")
        self.assertTrue(applied)
        self.assertIs(False, value)
        self.assertIs(False, prompt["5"]["inputs"]["标签模式"])

    def test_applies_text_and_combo_values(self):
        prompt = make_prompt()
        self.assertEqual(server._apply_submitted_input(prompt, "6::text", 123), (True, "123"))
        self.assertEqual(prompt["6"]["inputs"]["text"], "123")
        self.assertEqual(server._apply_submitted_input(prompt, "6::sampler_name", "dpmpp_2m"), (True, "dpmpp_2m"))
        self.assertEqual(server._apply_submitted_input(prompt, "6::新式下拉", "sdxl"), (True, "sdxl"))
        # 候选值不是字符串时（例如数字下拉），按字符串比对回原值
        self.nodes_mapping["NumberCombo"] = type(
            "NumberCombo",
            (),
            {"INPUT_TYPES": classmethod(lambda cls: {"required": {"批次": ([1, 2, 3],)}})},
        )
        prompt["7"] = {"class_type": "NumberCombo", "inputs": {"批次": 1}}
        self.assertEqual(server._apply_submitted_input(prompt, "7::批次", "2"), (True, 2))
        self.assertEqual(prompt["7"]["inputs"]["批次"], 2)

    def test_rejects_unknown_node_and_input(self):
        prompt = make_prompt()
        before = copy.deepcopy(prompt)
        for key in ("99::text", "5::不存在", "5::标签模式x", "4::步数"):
            applied, _ = server._apply_submitted_input(prompt, key, "x")
            self.assertFalse(applied, key)
        self.assertEqual(prompt, before)
        self.assertNotIn("99", prompt)

    def test_rejects_malformed_keys(self):
        prompt = make_prompt()
        before = copy.deepcopy(prompt)
        long_key = "1" * 70 + "::text"
        too_long = "5::" + "t" * 190
        for key in ("5", "", "5::", "::text", "5::clip::0", "5 ::text", "节点/../x::text", long_key, too_long):
            applied, _ = server._apply_submitted_input(prompt, key, "x")
            self.assertFalse(applied, key)
        self.assertEqual(prompt, before)

    def test_clamps_numbers_and_keeps_the_declared_type(self):
        prompt = make_prompt()
        self.assertEqual(server._apply_submitted_input(prompt, "6::步数", 9999), (True, 100))
        self.assertEqual(server._apply_submitted_input(prompt, "6::步数", "-5"), (True, 1))
        # 小数写法照样收，INT 取整
        self.assertEqual(server._apply_submitted_input(prompt, "6::步数", "12.8"), (True, 12))
        self.assertIsInstance(prompt["6"]["inputs"]["步数"], int)
        self.assertEqual(server._apply_submitted_input(prompt, "6::cfg", 99), (True, 30.0))
        self.assertIsInstance(prompt["6"]["inputs"]["cfg"], float)
        self.assertEqual(server._apply_submitted_input(prompt, "6::cfg", "0.25"), (True, 0.25))

    def test_type_fallbacks_skip_bad_values(self):
        prompt = make_prompt()
        for bad in ("abc", "", None, [1, 2], {"a": 1}, "nan", "inf"):
            applied, _ = server._apply_submitted_input(prompt, "6::步数", bad)
            self.assertFalse(applied, repr(bad))
        # 转不动的值跳过，prompt 里留着原值
        self.assertEqual(prompt["6"]["inputs"]["步数"], 20)
        # BOOLEAN 只认那几种写法
        applied, _ = server._apply_submitted_input(prompt, "5::每次随机", "maybe")
        self.assertFalse(applied)
        self.assertIs(False, prompt["5"]["inputs"]["每次随机"])
        # COMBO 不在候选里就跳过
        applied, _ = server._apply_submitted_input(prompt, "6::sampler_name", "不存在的采样器")
        self.assertFalse(applied)
        self.assertEqual(prompt["6"]["inputs"]["sampler_name"], "euler")

    def test_linked_input_is_never_overwritten(self):
        prompt = make_prompt()
        applied, _ = server._apply_submitted_input(prompt, "5::clip", "a.safetensors")
        self.assertFalse(applied)
        self.assertEqual(prompt["5"]["inputs"]["clip"], ["4", 0])
        applied, _ = server._apply_submitted_input(prompt, "6::model", "x")
        self.assertFalse(applied)
        self.assertEqual(prompt["6"]["inputs"]["model"], ["4", 0])

    def test_unregistered_class_falls_back_to_current_value_type(self):
        prompt = {"7": {"class_type": "SomeUnregisteredNode", "inputs": {"tag_mode": True, "text": "hi"}}}
        # 声明拿不到时按当前值猜类型：开关别被写成字符串 "False"
        applied, value = server._apply_submitted_input(prompt, "7::tag_mode", False)
        self.assertTrue(applied)
        self.assertIs(False, value)
        self.assertIs(False, prompt["7"]["inputs"]["tag_mode"])
        # 但图里仍然按规格退化成 STRING
        graph = server._workflow_graph(prompt, None, [])
        self.assertEqual(entry_of(node_of(graph, "7"), "tag_mode")["type"], "STRING")


class FrontendControlTests(unittest.TestCase):
    """前端专有控件（种子模式 control_after_generate）：电脑画布上有，API prompt 里没有。"""

    def setUp(self):
        server._INPUT_SPECS_CACHE.clear()
        self.nodes_mapping = dict(NODE_CLASSES)
        self.nodes_mapping["SeedNode"] = SeedNode
        self.previous_nodes = sys.modules.get("nodes")
        module = types.ModuleType("nodes")
        module.NODE_CLASS_MAPPINGS = self.nodes_mapping
        sys.modules["nodes"] = module

    def tearDown(self):
        if self.previous_nodes is None:
            sys.modules.pop("nodes", None)
        else:
            sys.modules["nodes"] = self.previous_nodes

    def graph(self, prompt, workflow):
        return server._workflow_graph(prompt, workflow, server._infer_fields(prompt))

    def test_control_follows_seed_and_takes_the_widget_value(self):
        prompt = make_seed_prompt()
        graph = self.graph(prompt, seed_workflow([42, "fixed", 20, "euler", ""]))
        names = [item["name"] for item in node_of(graph, "3")["inputs"]]
        self.assertEqual(names, ["seed", "control_after_generate", "steps", "sampler_name", "note"])
        control = entry_of(node_of(graph, "3"), "control_after_generate")
        self.assertEqual(control, {
            "name": "control_after_generate",
            "type": "COMBO",
            "options": ["fixed", "increment", "decrement", "randomize"],
            "value": "fixed",
            "frontend": True,
        })
        # 前端专有控件不在 API prompt 里，只是给手机端看的
        self.assertNotIn("control_after_generate", prompt["3"]["inputs"])

    def test_control_is_inserted_even_when_seed_is_linked(self):
        # 种子被连线接管时画布上依然有那一格（KSamplerAdvanced 的 noise_seed 就是这样）
        prompt = {
            "3": {"class_type": "SeedNode", "inputs": {"seed": ["4", 0], "steps": 20, "sampler_name": "euler", "note": ""}},
            "4": {"class_type": "SeedNode", "inputs": {"seed": 1, "steps": 20, "sampler_name": "euler", "note": ""}},
        }
        graph = self.graph(prompt, seed_workflow([466951792602971, "increment", 20, "euler", ""]))
        node = node_of(graph, "3")
        self.assertEqual([item["name"] for item in node["inputs"]][:2], ["seed", "control_after_generate"])
        self.assertEqual(entry_of(node, "seed")["link"], {"node": "4", "slot": 0})
        self.assertEqual(entry_of(node, "control_after_generate")["value"], "increment")

    def test_control_value_falls_back_to_randomize(self):
        for widgets_values in ([42, "", 20, "euler", ""], [42, None, 20, "euler", ""], [42]):
            graph = self.graph(make_seed_prompt(), seed_workflow(widgets_values))
            control = entry_of(node_of(graph, "3"), "control_after_generate")
            self.assertEqual(control["value"], "randomize", repr(widgets_values))

    def test_control_is_skipped_without_the_native_graph(self):
        prompt = make_seed_prompt()
        for workflow in (None, {}, {"nodes": []}, {"nodes": [{"id": 3, "pos": [0, 0]}]},
                         {"nodes": [{"id": 3, "pos": [0, 0], "widgets_values": None}]}):
            graph = self.graph(prompt, workflow)
            names = [item["name"] for item in node_of(graph, "3")["inputs"]]
            self.assertNotIn("control_after_generate", names, repr(workflow))

    def test_control_is_skipped_when_slots_do_not_line_up(self):
        prompt = make_seed_prompt()
        for widgets_values in ([42, "fixed", 20], ["fixed", 42, 20, "euler", ""], [42, "fixed", 20, "euler", "", "extra"]):
            graph = self.graph(prompt, seed_workflow(widgets_values))
            names = [item["name"] for item in node_of(graph, "3")["inputs"]]
            self.assertNotIn("control_after_generate", names, repr(widgets_values))

    def test_control_is_skipped_when_the_class_does_not_resolve(self):
        prompt = {"3": {"class_type": "UnknownSeedNode", "inputs": {"seed": 42}}}
        graph = self.graph(prompt, seed_workflow([42, "fixed"]))
        names = [item["name"] for item in node_of(graph, "3")["inputs"]]
        self.assertEqual(names, ["seed"])

    def test_submitting_a_frontend_key_is_silently_ignored(self):
        prompt = make_seed_prompt()
        before = copy.deepcopy(prompt)
        applied, value = server._apply_submitted_input(prompt, "3::control_after_generate", "fixed")
        self.assertFalse(applied)
        self.assertIsNone(value)
        self.assertEqual(prompt, before)
        # 同一个节点上真实存在的输入照样能写
        self.assertEqual(server._apply_submitted_input(prompt, "3::seed", "7"), (True, 7))


if __name__ == "__main__":
    unittest.main(verbosity=2)
