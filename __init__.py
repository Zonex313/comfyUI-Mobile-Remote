"""ComfyUI Mobile Remote plugin entry point.

The extension registers a mobile web UI and HTTP endpoints on ComfyUI's existing
PromptServer, plus one optional graph node ("CLIP文本编码丨随机标签") that mirrors
the mobile tag engine on the desktop canvas.
"""

from .server import register_routes

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .mobile_tag_node import NODE_CLASS_MAPPINGS as _TAG_NODES
    from .mobile_tag_node import NODE_DISPLAY_NAME_MAPPINGS as _TAG_NODE_NAMES

    NODE_CLASS_MAPPINGS.update(_TAG_NODES)
    NODE_DISPLAY_NAME_MAPPINGS.update(_TAG_NODE_NAMES)
except Exception:  # pragma: no cover - a node import error must not break the plugin
    import logging

    logging.getLogger(__name__).exception("[Mobile Remote] tag node registration failed")

WEB_DIRECTORY = "./web"

try:
    register_routes()
except Exception:
    # A remote-control convenience layer must never prevent ComfyUI from booting.
    import logging

    logging.getLogger(__name__).exception("[Mobile Remote] route registration failed")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
