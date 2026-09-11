"""Temporary browser fixture: no ComfyUI imports, real workflows, disk outputs or GPU jobs."""
import asyncio
import importlib.util
import json
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("phone_settings", ROOT / "phone_settings.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
workspace = tempfile.TemporaryDirectory(prefix="comfy-mobile-settings-test-")
app = web.Application()
routes = web.RouteTableDef()
store = module.register_phone_settings(SimpleNamespace(routes=routes), root=workspace.name)
settings_posts = []
submitted = []
WORKFLOW_ID = "aaaaaaaaaaaaaaaaaaaa"

@web.middleware
async def record(request, handler):
    if request.path == "/mobile/api/settings" and request.method == "POST":
        settings_posts.append({"at": int(time.time() * 1000), "body": await request.json()})
        # aiohttp read() caches bytes; settings handler uses stream, so restore a compatible request handler here.
        try:
            result = await asyncio.to_thread(store.save_json, json.dumps(settings_posts[-1]["body"]).encode())
            return web.json_response(result)
        except module.SettingsError as exc:
            return module._error_response(exc)
    return await handler(request)
app.middlewares.append(record)

@routes.get("/mobile")
async def index(_request):
    return web.FileResponse(ROOT / "mobile" / "index.html", headers={"Cache-Control":"no-store"})

@routes.get("/mobile/assets/{filename}")
async def asset(request):
    name = request.match_info["filename"]
    if name not in {"app.js", "settings-sync.js", "preset-catalog.js", "progress-sync.js", "styles.css", "icon.svg", "prompt-presets.json"}:
        raise web.HTTPNotFound()
    return web.FileResponse(ROOT / "mobile" / name, headers={"Cache-Control":"no-store"})

@routes.get("/mobile/manifest.webmanifest")
async def manifest(_request):
    return web.json_response({"name":"Mobile settings fixture", "start_url":"/mobile"})

@routes.get("/mobile/api/status")
async def status(_request):
    return web.json_response({"ok":True,"online":True,"running":0,"pending":0,"version":"test", "mobile_urls":[]})

@routes.get("/mobile/api/workflows")
async def workflows(_request):
    return web.json_response({"ok":True,"workflows":[{"id":WORKFLOW_ID,"name":"同步验证", "node_count":4}]})

@routes.get("/mobile/api/workflows/{workflow_id}")
async def workflow(_request):
    fields = [
        {"id":"1::text", "input":"text", "label":"正向提示词", "value":"initial", "kind":"textarea", "group":"basic", "node_title":"提示词"},
        {"id":"2::unet_name", "input":"unet_name", "label":"模型", "value":"model-a.safetensors", "options":["model-a.safetensors","model-b.safetensors","model-c.safetensors"], "kind":"select", "group":"basic", "node_title":"模型"},
        {"id":"3::seed", "input":"seed", "label":"种子", "value":42, "kind":"number", "randomizable":True, "group":"advanced", "node_title":"采样"},
    ]
    return web.json_response({"ok":True,"workflow":{"id":WORKFLOW_ID,"name":"同步验证", "node_count":4, "fields":fields}})

@routes.get("/mobile/api/progress")
async def progress(_request):
    return web.json_response({"ok":True,"prompt_id":None,"nodes":{},"active_job":None,
                              "pending_count":0,"running_count":0,"running_ids":[]})

@routes.get("/mobile/api/jobs")
async def jobs(_request):
    return web.json_response({"ok":True,"jobs":[],"total":0})

@routes.post("/mobile/api/jobs")
async def create_job(request):
    submitted.append(await request.json())
    return web.json_response({"ok":True,"prompt_id":f"fixture-{len(submitted)}"})

@routes.get("/ws")
async def websocket(request):
    socket = web.WebSocketResponse()
    await socket.prepare(request)
    await socket.send_json({"type":"status", "data":{}})
    async for _message in socket:
        pass
    return socket

@routes.get("/test/report")
async def report(_request):
    return web.json_response({"settings_posts":settings_posts,"submitted":submitted,"snapshot":store.snapshot()})

app.add_routes(routes)
if __name__ == "__main__":
    try:
        web.run_app(app, host="127.0.0.1", port=8197, access_log=None)
    finally:
        workspace.cleanup()
