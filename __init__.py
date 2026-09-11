"""ComfyUI Mobile Remote plugin entry point.

The extension deliberately contributes no graph nodes. Importing it registers a
mobile web UI and HTTP endpoints on ComfyUI's existing PromptServer.
"""

from .server import register_routes

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

try:
    register_routes()
except Exception:
    # A remote-control convenience layer must never prevent ComfyUI from booting.
    import logging

    logging.getLogger(__name__).exception("[Mobile Remote] route registration failed")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
