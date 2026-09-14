"""Isolated tests for the tag-mode CLIPTextEncode stand-in (mobile_tag_node.py).

No ComfyUI runtime, server, model, or GPU is needed: the node module only imports
`comfy.comfy_types`, which is importable because the embedded python's
`python313._pth` puts the ComfyUI root on sys.path. When that import is not
available, a minimal stub for `comfy.comfy_types` is injected instead so these
tests stay self-contained. Force the stub path with:

    set MOBILE_TAG_NODE_FORCE_STUB=1

Run the suite:
    python.exe -B -m unittest discover -s tests -p "test_mobile_tag_node.py"
"""
from __future__ import annotations

import importlib.util
import inspect
import os
import sys
import unittest
from enum import Enum
from itertools import product
from pathlib import Path


sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
FORCE_STUB = os.environ.get("MOBILE_TAG_NODE_FORCE_STUB", "").strip().lower() in {"1", "true", "yes"}


def _load_comfy_types():
    """Return (IO, ComfyNodeABC, InputTypeDict, source) from the real module or a stub."""
    if not FORCE_STUB:
        try:
            from comfy.comfy_types import IO, ComfyNodeABC, InputTypeDict

            return IO, ComfyNodeABC, InputTypeDict, "real"
        except Exception:
            pass

    class IO(str, Enum):
        CLIP = "CLIP"
        STRING = "STRING"
        BOOLEAN = "BOOLEAN"
        CONDITIONING = "CONDITIONING"

    class ComfyNodeABC:
        pass

    class InputTypeDict(dict):
        pass

    package = sys.modules.get("comfy") or type(sys)("comfy")
    package.__path__ = []
    comfy_types = type(sys)("comfy.comfy_types")
    comfy_types.IO = IO
    comfy_types.ComfyNodeABC = ComfyNodeABC
    comfy_types.InputTypeDict = InputTypeDict
    package.comfy_types = comfy_types
    sys.modules["comfy"] = package
    sys.modules["comfy.comfy_types"] = comfy_types
    return IO, ComfyNodeABC, InputTypeDict, "stub"


IO, ComfyNodeABC, InputTypeDict, COMFY_SOURCE = _load_comfy_types()

MODULE_PATH = ROOT / "mobile_tag_node.py"
SPEC = importlib.util.spec_from_file_location("mobile_tag_node_under_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mobile_tag_node = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mobile_tag_node)

DISPLAY_NAME = "CLIP文本编码丨随机标签"
CLASS_NAME = "MobileTagCLIPTextEncode"

# The two switches use Chinese *input keys* on purpose; both are front-end only.
TAG_MODE_KEY = "标签模式"
RANDOMIZE_KEY = "每次随机"
REQUIRED_INPUTS = ["clip", "text", TAG_MODE_KEY, RANDOMIZE_KEY]
SWITCH_COMBINATIONS = list(product((False, True), (False, True)))


def switch_kwargs(tag_mode, randomize):
    return {TAG_MODE_KEY: tag_mode, RANDOMIZE_KEY: randomize}


class FakeClip:
    """Records the exact encode path taken, like the real CLIP object would."""

    def __init__(self, tokens="TOKENS", conditioning="CONDITIONING"):
        self.tokens = tokens
        self.conditioning = conditioning
        self.calls = []

    def tokenize(self, text):
        self.calls.append(("tokenize", text))
        return self.tokens

    def encode_from_tokens_scheduled(self, tokens):
        self.calls.append(("encode_from_tokens_scheduled", tokens))
        return self.conditioning


class InputTypesTests(unittest.TestCase):
    def setUp(self):
        self.inputs = mobile_tag_node.MobileTagCLIPTextEncode.INPUT_TYPES()
        self.required = self.inputs["required"]

    def test_required_keys_are_complete_and_ordered(self):
        self.assertEqual({"required"}, set(self.inputs))
        self.assertEqual(set(REQUIRED_INPUTS), set(self.required))
        self.assertEqual(REQUIRED_INPUTS, list(self.required))

    def test_clip_is_a_clip_socket(self):
        type_or_options = self.required["clip"]
        self.assertEqual(IO.CLIP, type_or_options[0])
        self.assertIsInstance(type_or_options[1], dict)

    def test_text_is_multiline_and_dynamic(self):
        type_or_options = self.required["text"]
        self.assertEqual(IO.STRING, type_or_options[0])
        options = type_or_options[1]
        self.assertTrue(options["multiline"])
        self.assertTrue(options["dynamicPrompts"])
        self.assertEqual("提示词文本", options["tooltip"])

    def test_tag_mode_defaults_to_false_with_labels(self):
        type_or_options = self.required[TAG_MODE_KEY]
        self.assertEqual(IO.BOOLEAN, type_or_options[0])
        options = type_or_options[1]
        self.assertIs(False, options["default"])
        self.assertEqual("标签模式", options["label_on"])
        self.assertEqual("普通文本", options["label_off"])
        self.assertIn("注入提示词", options["tooltip"])

    def test_randomize_each_time_defaults_to_true_with_labels(self):
        type_or_options = self.required[RANDOMIZE_KEY]
        self.assertEqual(IO.BOOLEAN, type_or_options[0])
        options = type_or_options[1]
        self.assertIs(True, options["default"])
        self.assertEqual("每次随机", options["label_on"])
        self.assertEqual("固定标签", options["label_off"])
        self.assertIn("每发起一次任务都重新随机一次标签", options["tooltip"])

    def test_both_switches_are_booleans_labelled_like_their_keys(self):
        for key in (TAG_MODE_KEY, RANDOMIZE_KEY):
            type_or_options = self.required[key]
            self.assertEqual(IO.BOOLEAN, type_or_options[0])
            self.assertEqual(key, type_or_options[1]["label_on"])
            self.assertNotEqual(type_or_options[1]["label_on"], type_or_options[1]["label_off"])


class NodeContractTests(unittest.TestCase):
    def test_class_contract(self):
        node_cls = mobile_tag_node.MobileTagCLIPTextEncode
        self.assertEqual((IO.CONDITIONING,), node_cls.RETURN_TYPES)
        self.assertEqual(("CONDITIONING",), node_cls.RETURN_TYPES)
        self.assertEqual("encode", node_cls.FUNCTION)
        self.assertEqual("model/conditioning", node_cls.CATEGORY)
        self.assertTrue(issubclass(node_cls, ComfyNodeABC))

    def test_display_name_attribute_matches_the_mapping(self):
        node_cls = mobile_tag_node.MobileTagCLIPTextEncode
        self.assertEqual(DISPLAY_NAME, node_cls.DISPLAY_NAME)

    def test_encode_signature_sweeps_extra_switches_into_kwargs(self):
        parameters = list(inspect.signature(mobile_tag_node.MobileTagCLIPTextEncode.encode).parameters.values())
        self.assertEqual(["self", "clip", "text", "kwargs"], [parameter.name for parameter in parameters])
        self.assertEqual(inspect.Parameter.VAR_KEYWORD, parameters[-1].kind)


class EncodeParityTests(unittest.TestCase):
    def test_encode_with_both_switches_off_matches_builtin_path(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        clip = FakeClip()
        result = node.encode(clip=clip, text="a cat", **switch_kwargs(False, False))
        self.assertEqual([("tokenize", "a cat"), ("encode_from_tokens_scheduled", "TOKENS")], clip.calls)
        # Built-in CLIPTextEncode returns a 1-tuple holding the conditioning.
        self.assertEqual(("CONDITIONING",), result)
        self.assertIsInstance(result, tuple)
        self.assertEqual(1, len(result))
        self.assertIs(clip.conditioning, result[0])

    def test_encode_with_both_switches_on_takes_the_same_path(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        clip = FakeClip(tokens=[("lora", 1.0)], conditioning="COND")
        result = node.encode(clip=clip, text="1girl, solo", **switch_kwargs(True, True))
        self.assertEqual([("tokenize", "1girl, solo"), ("encode_from_tokens_scheduled", [("lora", 1.0)])], clip.calls)
        self.assertEqual(("COND",), result)
        self.assertEqual((clip.conditioning,), result)

    def test_every_switch_combination_takes_the_builtin_path(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        for tag_mode, randomize in SWITCH_COMBINATIONS:
            with self.subTest(标签模式=tag_mode, 每次随机=randomize):
                clip = FakeClip(conditioning=f"COND-{tag_mode}-{randomize}")
                result = node.encode(clip=clip, text="a cat", **switch_kwargs(tag_mode, randomize))
                self.assertEqual(
                    [("tokenize", "a cat"), ("encode_from_tokens_scheduled", "TOKENS")],
                    clip.calls,
                )
                self.assertEqual((f"COND-{tag_mode}-{randomize}",), result)
                self.assertEqual(1, len(result))

    def test_switches_may_be_omitted_entirely(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        clip = FakeClip()
        result = node.encode(clip, "a cat")
        self.assertEqual([("tokenize", "a cat"), ("encode_from_tokens_scheduled", "TOKENS")], clip.calls)
        self.assertEqual(("CONDITIONING",), result)

    def test_unknown_future_switches_are_swallowed_by_kwargs(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        clip = FakeClip()
        result = node.encode(clip=clip, text="a cat", 以后新加的开关=True, **switch_kwargs(True, True))
        self.assertEqual([("tokenize", "a cat"), ("encode_from_tokens_scheduled", "TOKENS")], clip.calls)
        self.assertEqual(("CONDITIONING",), result)

    def test_encode_does_not_mutate_the_prompt(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        clip = FakeClip()
        for tag_mode, randomize in SWITCH_COMBINATIONS:
            node.encode(clip=clip, text="unchanged", **switch_kwargs(tag_mode, randomize))
        tokenized = [text for name, text in clip.calls if name == "tokenize"]
        self.assertEqual(["unchanged"] * len(SWITCH_COMBINATIONS), tokenized)
        self.assertEqual(2 * len(SWITCH_COMBINATIONS), len(clip.calls))

    def test_encode_returns_exactly_one_conditioning(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        for tag_mode, randomize in SWITCH_COMBINATIONS:
            result = node.encode(FakeClip(conditioning=tag_mode), "x", **switch_kwargs(tag_mode, randomize))
            self.assertEqual((tag_mode,), result)
            self.assertEqual(1, len(result))

    def test_none_clip_raises_like_the_builtin(self):
        node = mobile_tag_node.MobileTagCLIPTextEncode()
        for kwargs in ({}, switch_kwargs(True, True)):
            with self.assertRaises(RuntimeError):
                node.encode(clip=None, text="a cat", **kwargs)


class MappingTests(unittest.TestCase):
    def test_class_mappings_export_the_node(self):
        self.assertEqual({CLASS_NAME: mobile_tag_node.MobileTagCLIPTextEncode}, mobile_tag_node.NODE_CLASS_MAPPINGS)

    def test_display_name_mappings_export_the_chinese_label(self):
        self.assertEqual({CLASS_NAME: DISPLAY_NAME}, mobile_tag_node.NODE_DISPLAY_NAME_MAPPINGS)

    def test_class_can_be_instantiated_from_the_mapping(self):
        node_cls = mobile_tag_node.NODE_CLASS_MAPPINGS[CLASS_NAME]
        self.assertTrue(callable(getattr(node_cls(), node_cls.FUNCTION)))


class ComfyTypesSourceTests(unittest.TestCase):
    def test_comfy_types_come_from_the_real_module_or_the_documented_stub(self):
        self.assertIn(COMFY_SOURCE, {"real", "stub"})


if __name__ == "__main__":
    unittest.main()
