"""Isolated tests: no ComfyUI runtime, server, user files or GPU required."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("local_workflow", Path(__file__).resolve().parents[1] / "local_workflow.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
prepare_local_prompt = MODULE.prepare_local_prompt


def spec(kind, **config):
    return {"type": kind, "required": True, "config": config}


SPECS = {
    "LoraLoader": {
        "model": spec("MODEL"), "clip": spec("CLIP"), "lora_name": spec("COMBO"),
        "strength_model": spec("FLOAT"), "strength_clip": spec("FLOAT"),
    },
    "SeedNode": {
        "forced": spec("STRING", forceInput=True), "linked": spec("STRING"),
        "seed": spec("INT"), "text": spec("STRING"),
    },
}


def lookup(kind):
    return SPECS.get(kind)


def fixture(bypassed=(), chain=False):
    nodes = [{"id": 1, "type": "CheckpointLoaderSimple", "mode": 0,
              "outputs": [{"type": "MODEL"}, {"type": "CLIP"}], "widgets_values": ["base.safetensors"]}]
    links = []
    prompt = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}}}
    source, compiled_source = 1, "1"
    for node_id in ([2, 5] if chain else [2]):
        first = len(links) + 1
        nodes.append({"id": node_id, "type": "LoraLoader", "mode": 4 if node_id in bypassed else 0,
                      "inputs": [{"name": "model", "type": "MODEL", "link": first},
                                 {"name": "clip", "type": "CLIP", "link": first + 1}],
                      "outputs": [{"type": "MODEL"}, {"type": "CLIP"}],
                      "widgets_values": [f"lora-{node_id}.safetensors", 0.75, 0.5]})
        links.extend([[first, source, 0, node_id, 0, "MODEL"], [first + 1, source, 1, node_id, 1, "CLIP"]])
        if node_id not in bypassed:
            prompt[str(node_id)] = {"class_type": "LoraLoader", "inputs": {
                "model": [compiled_source, 0], "clip": [compiled_source, 1],
                "lora_name": f"lora-{node_id}.safetensors", "strength_model": 0.75, "strength_clip": 0.5,
            }}
            compiled_source = str(node_id)
        source = node_id
    first = len(links) + 1
    nodes.extend([
        {"id": 3, "type": "Sampler", "mode": 0, "inputs": [{"name": "model", "type": "MODEL", "link": first}]},
        {"id": 4, "type": "TextEncode", "mode": 0, "inputs": [{"name": "clip", "type": "CLIP", "link": first + 1}]},
        {"id": 8, "type": "VirtualCustom", "mode": 0, "widgets_values": ["raw native text"]},
    ])
    links.extend([[first, source, 0, 3, 0, "MODEL"], [first + 1, source, 1, 4, 0, "CLIP"]])
    prompt.update({
        "3": {"class_type": "Sampler", "inputs": {"model": [compiled_source, 0], "seed": 94721}},
        "4": {"class_type": "TextEncode", "inputs": {"clip": [compiled_source, 1], "text": "desktop expanded text"}},
        "8:inner": {"class_type": "ActualCustom", "inputs": {"text": "desktop transformed value", "metadata": {"custom": [1, 2, 3]}}},
    })
    return {"prompt": prompt, "workflow": {"nodes": nodes, "links": links, "extra": {"desktop": True}}}


def native_node(record, node_id):
    return next(node for node in record["workflow"]["nodes"] if node["id"] == node_id)


def run(record, modes=None, widgets=None):
    return prepare_local_prompt(record, modes, widgets, input_specs=lookup)


class LocalWorkflowTests(unittest.TestCase):
    def test_unchanged_prompt_exact_and_independent_without_registry(self):
        record = fixture()
        original = deepcopy(record)
        with patch.dict(sys.modules, {"nodes": None}):
            prompt, native = prepare_local_prompt(record)
        self.assertEqual(prompt, record["prompt"])
        self.assertEqual(native, record["workflow"])
        prompt["8:inner"]["inputs"]["metadata"]["custom"].append(99)
        native["nodes"][0]["widgets_values"][0] = "phone copy"
        self.assertEqual(record, original)
        self.assertEqual(run(record, {"2": 0}, {"2": native_node(record, 2)["widgets_values"]}),
                         (record["prompt"], record["workflow"]))

    def test_lora_enabled_bypass_enabled_roundtrip_model_and_clip(self):
        record = fixture()
        original = deepcopy(record)
        prompt, native = run(record, {"2": 4})
        self.assertNotIn("2", prompt)
        self.assertEqual(prompt["3"]["inputs"]["model"], ["1", 0])
        self.assertEqual(prompt["4"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(prompt["8:inner"], original["prompt"]["8:inner"])
        restored, restored_native = run({"prompt": prompt, "workflow": native}, {"2": 0})
        self.assertEqual(restored, original["prompt"])
        self.assertEqual(restored_native, original["workflow"])
        self.assertEqual(record, original)

    def test_originally_bypassed_chain_can_restore_either_or_both_loras(self):
        record = fixture(bypassed=(2, 5), chain=True)
        for modes, model_source, second_source in [({"2": 0}, "2", None), ({"5": 0}, "5", "1"), ({"2": 0, "5": 0}, "5", "2")]:
            with self.subTest(modes=modes):
                prompt, _ = run(record, modes)
                self.assertEqual(prompt["3"]["inputs"]["model"], [model_source, 0])
                self.assertEqual(prompt["4"]["inputs"]["clip"], [model_source, 1])
                if second_source:
                    self.assertEqual(prompt["5"]["inputs"]["model"], [second_source, 0])
                    self.assertEqual(prompt["5"]["inputs"]["clip"], [second_source, 1])
        self.assertNotIn("2", record["prompt"])

    def test_bypass_enabled_chain_follows_two_slots(self):
        prompt, _ = run(fixture(chain=True), {"2": 4, "5": 4})
        self.assertNotIn("2", prompt)
        self.assertNotIn("5", prompt)
        self.assertEqual(prompt["3"]["inputs"]["model"], ["1", 0])
        self.assertEqual(prompt["4"]["inputs"]["clip"], ["1", 1])

    def test_reroute_is_followed_and_existing_subgraph_source_is_allowed(self):
        record = fixture(bypassed=(2,))
        record["workflow"]["links"][2][1:3] = [7, 0]
        record["workflow"]["links"].append([5, 2, 0, 7, 0, "MODEL"])
        record["workflow"]["nodes"].append({"id": 7, "type": "Reroute", "mode": 0,
            "inputs": [{"name": "", "type": "*", "link": 5}], "outputs": [{"type": "*"}]})
        record["workflow"]["links"][0][1] = "8:model"
        record["prompt"]["8:model"] = {"class_type": "InnerModel", "inputs": {}}
        record["prompt"]["3"]["inputs"]["model"] = ["8:model", 0]
        prompt, _ = run(record, {"2": 0})
        self.assertEqual(prompt["2"]["inputs"]["model"], ["8:model", 0])
        self.assertEqual(prompt["3"]["inputs"]["model"], ["2", 0])

    def test_compiled_only_references_to_bypassed_node_are_rewired(self):
        record = fixture()
        record["prompt"]["8:inner"]["inputs"]["clip"] = ["2", 1]
        prompt, _ = run(record, {"2": 4})
        self.assertEqual(prompt["8:inner"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(prompt["8:inner"]["inputs"]["text"], "desktop transformed value")

    def test_widget_edits_preserve_untouched_compiled_values(self):
        record = fixture()
        record["prompt"]["2"]["inputs"]["lora_name"] = "desktop-resolved/path.safetensors"
        prompt, native = run(record, widgets={"2": ["lora-2.safetensors", 0.2, 0.5]})
        self.assertEqual(prompt["2"]["inputs"]["strength_model"], 0.2)
        self.assertEqual(prompt["2"]["inputs"]["lora_name"], "desktop-resolved/path.safetensors")
        self.assertEqual(native["nodes"][1]["widgets_values"][1], 0.2)
        self.assertEqual(native_node(record, 2)["widgets_values"][1], 0.75)

    def test_widget_edit_and_restore_originally_bypassed_lora(self):
        record = fixture(bypassed=(2,))
        prompt, _ = run(record, {"2": 0}, {"2": ["phone.safetensors", 0.25, 0.1]})
        self.assertEqual(prompt["2"]["inputs"]["lora_name"], "phone.safetensors")
        self.assertEqual(prompt["2"]["inputs"]["model"], ["1", 0])

    def test_object_widgets_use_names_and_reject_extra_or_missing(self):
        record = fixture(bypassed=(2,))
        raw = {"strength_clip": 0.5, "lora_name": "named.safetensors", "strength_model": 0.75}
        native_node(record, 2)["widgets_values"] = raw
        prompt, _ = run(record, {"2": 0})
        self.assertEqual(prompt["2"]["inputs"]["lora_name"], "named.safetensors")
        for broken in ({**raw, "unknown": 3}, {"lora_name": "missing.safetensors"}):
            with self.subTest(raw=broken), self.assertRaisesRegex(ValueError, "控件名称不匹配"):
                run(record, {"2": 0}, {"2": broken})

    def test_widget_layout_skips_force_linked_and_seed_control_slot(self):
        record = fixture()
        record["workflow"]["nodes"].append({"id": 9, "type": "SeedNode", "mode": 0,
            "inputs": [{"name": "forced", "link": 90}, {"name": "linked", "link": 91}],
            "widgets_values": [10, "randomize", "native text"]})
        record["prompt"]["9"] = {"class_type": "SeedNode", "inputs": {
            "forced": ["8:inner", 0], "linked": ["8:inner", 1], "seed": 99, "text": "compiled text"}}
        prompt, _ = run(record, widgets={"9": [10, "fixed", "new text"]})
        self.assertEqual(prompt["9"]["inputs"]["seed"], 99)
        self.assertEqual(prompt["9"]["inputs"]["text"], "new text")
        self.assertEqual(prompt["9"]["inputs"]["linked"], ["8:inner", 1])
        self.assertNotIn("control_after_generate", prompt["9"]["inputs"])

    def test_bad_modes_unknown_ids_and_serialization_reject_without_mutation(self):
        record = fixture()
        original = deepcopy(record)
        for modes in ({"2": 2}, {"2": "4"}, {"2": True}, {"2": 4.0}, {"new": 0}, {"8:inner": 4}):
            with self.subTest(modes=modes), self.assertRaises(ValueError):
                run(record, modes)
        for raw in (["missing"], ["extra", 1, 2, 3], "not widgets"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                run(record, widgets={"2": raw})
        with self.assertRaises(ValueError):
            run(record, widgets={"unknown": []})
        self.assertEqual(record, original)

    def test_unregistered_restore_and_ambiguous_widget_schema_reject(self):
        record = fixture(bypassed=(2,))
        native_node(record, 2)["type"] = "Unregistered"
        with self.assertRaisesRegex(ValueError, "未注册"):
            run(record, {"2": 0})
        record = fixture(bypassed=(2,))
        native_node(record, 2)["widgets_values"].append("custom-extra")
        with self.assertRaisesRegex(ValueError, "控件数量不匹配"):
            run(record, {"2": 0})

    def test_bypass_prefers_same_slot_then_unique_exact_type(self):
        record = fixture()
        node = native_node(record, 2)
        node["inputs"] = [node["inputs"][1], node["inputs"][0]]
        record["workflow"]["links"][0][4] = 1
        record["workflow"]["links"][1][4] = 0
        prompt, _ = run(record, {"2": 4})
        self.assertEqual(prompt["3"]["inputs"]["model"], ["1", 0])
        self.assertEqual(prompt["4"]["inputs"]["clip"], ["1", 1])
        node["inputs"].append({"name": "other_model", "type": "MODEL", "link": None})
        with self.assertRaisesRegex(ValueError, "无法唯一匹配"):
            run(record, {"2": 4})

    def test_missing_source_bad_slot_bypass_cycle_and_active_cycle_reject(self):
        for broken in ("missing", "slot", "bypass_cycle", "active_cycle"):
            record = fixture(bypassed=(2,) if broken == "active_cycle" else ())
            if broken == "missing":
                record["workflow"]["links"][0][1] = 999
            elif broken == "slot":
                record["workflow"]["links"][0][2] = 99
            else:
                record["workflow"]["links"][0][1] = 2
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                run(record, {"2": 0 if broken == "active_cycle" else 4})

    def test_affected_custom_compilation_fails_instead_of_overwriting_it(self):
        record = fixture(bypassed=(2,))
        record["prompt"]["3"]["inputs"]["model"] = ["8:inner", 0]
        with self.assertRaisesRegex(ValueError, "自定义编译行为"):
            run(record, {"2": 0})

    def test_widget_values_cannot_inject_links_or_objects(self):
        record = fixture()
        original = deepcopy(record)
        for value in (["1", 0], {"class_type": "Injected"}, None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "不能传入连线或对象"):
                run(record, widgets={"2": [value, 0.75, 0.5]})
        self.assertEqual(record, original)

    def test_default_registry_lookup_is_lazy_and_compatible(self):
        record = fixture(bypassed=(2,))
        raw = {"required": {
            "model": ("MODEL",), "clip": ("CLIP",), "lora_name": (["lora-2.safetensors"],),
            "strength_model": ("FLOAT", {}), "strength_clip": ("FLOAT", {}),
        }}
        registry = SimpleNamespace(NODE_CLASS_MAPPINGS={"LoraLoader": SimpleNamespace(INPUT_TYPES=lambda: raw)})
        with patch.dict(sys.modules, {"nodes": registry}):
            prompt, _ = prepare_local_prompt(record, {"2": 0})
        self.assertEqual(prompt["2"]["inputs"]["clip"], ["1", 1])


class NativeMetadataTests(unittest.TestCase):
    def test_named_values_update_only_matching_slots_and_never_mutate_source(self):
        record = fixture()
        original = deepcopy(record)
        submitted = {"2::strength_model": 0.125, "2::lora_name": "phone.safetensors"}
        calls = []

        def only_edited_node(kind):
            calls.append(kind)
            self.assertEqual(kind, "LoraLoader")
            return SPECS[kind]

        native = MODULE.apply_named_values_to_native(record["workflow"], submitted, input_specs=only_edited_node)
        self.assertEqual(native["nodes"][1]["widgets_values"], ["phone.safetensors", 0.125, 0.5])
        self.assertEqual(native["links"], record["workflow"]["links"])
        self.assertEqual(native["nodes"][-1], record["workflow"]["nodes"][-1])
        self.assertEqual(record, original)
        self.assertEqual(calls, ["LoraLoader"])
        self.assertEqual(submitted, {"2::strength_model": 0.125, "2::lora_name": "phone.safetensors"})

    def test_named_object_widgets_keep_name_mapping(self):
        record = fixture()
        native_node(record, 2)["widgets_values"] = {
            "strength_clip": 0.5, "lora_name": "original.safetensors", "strength_model": 0.75,
        }
        native = MODULE.apply_named_values_to_native(record["workflow"], {"2::strength_clip": 0.3}, input_specs=lookup)
        self.assertEqual(native["nodes"][1]["widgets_values"], {
            "strength_clip": 0.3, "lora_name": "original.safetensors", "strength_model": 0.75,
        })

    def test_seed_updates_correct_slot_and_preserves_frontend_linked_and_forced_fields(self):
        native = {"nodes": [{"id": 9, "type": "SeedNode",
            "inputs": [{"name": "forced", "link": 1}, {"name": "linked", "link": 2}],
            "widgets_values": [12, "randomize", "source text"]}]}
        original = deepcopy(native)
        submitted = {"9::seed": 987, "9::text": "phone text", "9::control_after_generate": "fixed",
                     "9::forced": "ignored", "9::linked": "ignored"}
        updated = MODULE.apply_named_values_to_native(native, submitted, input_specs=lookup)
        self.assertEqual(updated["nodes"][0]["widgets_values"], [987, "randomize", "phone text"])
        self.assertEqual(updated["nodes"][0]["inputs"], native["nodes"][0]["inputs"])
        self.assertEqual(native, original)

    def test_unknown_and_ambiguous_branches_do_not_break_other_metadata_updates(self):
        record = fixture(chain=True)
        native_node(record, 5)["widgets_values"].append("custom frontend widget")
        original = deepcopy(record)

        def lookup_with_unknown(kind):
            if kind == "VirtualCustom":
                raise RuntimeError("custom node registry unavailable")
            return lookup(kind)

        native = MODULE.apply_named_values_to_native(record["workflow"], {
            "2::strength_model": 0.2, "5::strength_model": 0.4, "8::text": "unknown custom layout",
        }, input_specs=lookup_with_unknown)
        self.assertEqual(native["nodes"][1]["widgets_values"][1], 0.2)
        self.assertEqual(native["nodes"][2], native_node(record, 5))
        self.assertEqual(native["nodes"][-1], native_node(record, 8))
        self.assertEqual(record, original)

    def test_unknown_keys_structured_values_and_duplicate_ids_never_guess(self):
        record = fixture()
        original = deepcopy(record["workflow"])
        updated = MODULE.apply_named_values_to_native(record["workflow"], {
            "2::strength_model": ["1", 0], "2::lora_name": {"node": 1},
            "2::unknown": 8, "missing::name": 3, "bad-key": 2,
        }, input_specs=lookup)
        self.assertEqual(updated, original)
        record["workflow"]["nodes"].append(deepcopy(native_node(record, 2)))
        updated = MODULE.apply_named_values_to_native(record["workflow"], {"2::strength_model": 0.2}, input_specs=lookup)
        self.assertEqual(updated, record["workflow"])

    def test_default_registry_and_noop_are_lazy(self):
        native = fixture()["workflow"]
        with patch.dict(sys.modules, {"nodes": None}):
            self.assertEqual(MODULE.apply_named_values_to_native(native, {}), native)
            self.assertEqual(MODULE.apply_named_values_to_native(native, {"2::strength_model": 0.2}), native)
        registry = SimpleNamespace(NODE_CLASS_MAPPINGS={"LoraLoader": SimpleNamespace(INPUT_TYPES=lambda: {
            "required": {"model": ("MODEL",), "clip": ("CLIP",), "lora_name": (["a"],),
                         "strength_model": ("FLOAT",), "strength_clip": ("FLOAT",)},
        })})
        with patch.dict(sys.modules, {"nodes": registry}):
            updated = MODULE.apply_named_values_to_native(native, {"2::strength_model": 0.25})
        self.assertEqual(updated["nodes"][1]["widgets_values"][1], 0.25)

    def test_zero_input_registered_node_restores_but_missing_registry_rejects(self):
        record = {"prompt": {}, "workflow": {"nodes": [
            {"id": 7, "type": "ZeroInput", "mode": 4, "widgets_values": [], "inputs": [], "outputs": []},
        ], "links": []}}
        prompt, native = prepare_local_prompt(record, {"7": 0}, input_specs=lambda kind: {})
        self.assertEqual(prompt, {"7": {"class_type": "ZeroInput", "inputs": {}}})
        self.assertEqual(native["nodes"][0]["mode"], 0)
        with self.assertRaisesRegex(ValueError, "未注册"):
            prepare_local_prompt(record, {"7": 0}, input_specs=lambda kind: None)
        registry = SimpleNamespace(NODE_CLASS_MAPPINGS={"ZeroInput": SimpleNamespace(INPUT_TYPES=lambda: {})})
        with patch.dict(sys.modules, {"nodes": registry}):
            prompt, _ = prepare_local_prompt(record, {"7": 0})
        self.assertEqual(prompt["7"]["inputs"], {})


if __name__ == "__main__":
    unittest.main()
