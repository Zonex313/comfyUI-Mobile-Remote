"""内置 CLIPTextEncode 的平替：多一个「标签模式」开关和「每次随机」开关。

两个开关都是给前端看的：
- 「标签模式」开着时，前端按标签词库把随机组合出来的标签注入 text；
- 「每次随机」开着时，每发起一次任务（批量任务逐个）都重新随机一次，
  关掉则沿用节点上当前显示的这套标签。
服务端这边不参与任何标签逻辑，编码路径与内置 CLIPTextEncode 逐行一致。

本模块只导出映射，不自行注册；由 custom node 包的 __init__.py 决定是否挂载。
"""

from comfy.comfy_types import IO, ComfyNodeABC, InputTypeDict


class MobileTagCLIPTextEncode(ComfyNodeABC):
    @classmethod
    def INPUT_TYPES(s) -> InputTypeDict:
        return {
            "required": {
                "clip": (IO.CLIP, {"tooltip": "The CLIP model used for encoding the text."}),
                "text": (IO.STRING, {"multiline": True, "dynamicPrompts": True, "tooltip": "提示词文本"}),
                "标签模式": (
                    IO.BOOLEAN,
                    {
                        "default": False,
                        "label_on": "标签模式",
                        "label_off": "普通文本",
                        "tooltip": "开启后由前端按标签词库随机组合标签并注入提示词；关闭时与普通 CLIP 文本编码完全一致",
                    },
                ),
                "每次随机": (
                    IO.BOOLEAN,
                    {
                        "default": True,
                        "label_on": "每次随机",
                        "label_off": "固定标签",
                        "tooltip": "开启后每发起一次任务都重新随机一次标签（批量任务逐个随机）；关闭则沿用节点上当前这套标签",
                    },
                ),
            }
        }

    RETURN_TYPES = (IO.CONDITIONING,)
    FUNCTION = "encode"

    CATEGORY = "model/conditioning"
    # ComfyUI 0.35 的 V1 注册只读模块级 NODE_DISPLAY_NAME_MAPPINGS，
    # 这个类属性目前不起作用（V3 走 schema.display_name），留一份做前向兼容。
    DISPLAY_NAME = "CLIP文本编码丨随机标签"
    DESCRIPTION = "用 CLIP 模型把提示词编码成 conditioning，并带「标签模式」「每次随机」两个开关给前端做随机标签组合。"
    SEARCH_ALIASES = ["text", "prompt", "text prompt", "tag", "random tag", "标签", "提示词"]

    def encode(self, clip, text, **kwargs):
        # 两个开关只服务前端；这里与内置 CLIPTextEncode.encode 完全一致。
        if clip is None:
            raise RuntimeError("ERROR: clip input is invalid: None\n\nIf the clip is from a checkpoint loader node your checkpoint does not contain a valid clip or text encoder model.")
        tokens = clip.tokenize(text)
        return (clip.encode_from_tokens_scheduled(tokens), )


NODE_CLASS_MAPPINGS = {"MobileTagCLIPTextEncode": MobileTagCLIPTextEncode}
NODE_DISPLAY_NAME_MAPPINGS = {"MobileTagCLIPTextEncode": "CLIP文本编码丨随机标签"}

__all__ = ["MobileTagCLIPTextEncode", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
