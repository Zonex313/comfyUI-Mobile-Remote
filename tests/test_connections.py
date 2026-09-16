"""Standalone transport tests; no plugin import, ComfyUI server, or real tunnel.

Run with the bundled Python (no extra packages required):
    python.exe -B tests/test_connections.py -v
"""
from __future__ import annotations

import asyncio
import contextlib
import gzip
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

from aiohttp import ClientSession, ClientTimeout, FormData, WSMsgType, web
from yarl import URL


# Loading this one file must not execute the plugin's GPU-dependent __init__.
sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).resolve().parents[1] / "connections.py"
SPEC = importlib.util.spec_from_file_location("mobile_connections_under_test", MODULE_PATH)
connections = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(connections)

WORKFLOW_ID = "0123456789abcdefabcd"
WAIT = 5
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = PLUGIN_ROOT / "mobile" / "index.html"
_INDEX_REF = re.compile(r"""(?:src|href)=["'](/mobile/[^"']+)["']""")


def index_referenced_paths():
    """Asset and document URLs the real phone page requests on boot."""
    found = []
    for raw in _INDEX_REF.findall(INDEX_HTML.read_text(encoding="utf-8")):
        path = raw.split("?", 1)[0]
        if path not in found:
            found.append(path)
    return found


def index_script_paths():
    return [path for path in index_referenced_paths() if path.startswith("/mobile/assets/")
            and path.endswith(".js")]


class MobileGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.uploads = []
        self.ws_received = []
        self.ws_closed = asyncio.Event()
        self.reply_status = 200
        self.reply_body = b"fake phone response\x00\xff"
        self.reply_headers = {"Content-Type": "application/octet-stream"}

        app = web.Application()
        app.router.add_route("*", "/{path:.*}", self.fake_upstream)
        self.upstream = web.AppRunner(app, access_log=None, shutdown_timeout=1)
        await self.upstream.setup()
        self.addAsyncCleanup(self.upstream.cleanup)
        site = web.TCPSite(self.upstream, "127.0.0.1", 0)
        await site.start()
        origin = "http://127.0.0.1:{}".format(self.upstream.addresses[0][1])
        self.gateway = connections.MobileGateway(origin)
        self.addAsyncCleanup(self.gateway.close)
        self.base = await self.gateway.start()
        self.client = ClientSession(timeout=ClientTimeout(total=WAIT), auto_decompress=False,
                                    trust_env=False)
        self.addAsyncCleanup(self.client.close)

    async def fake_upstream(self, request):
        recorded = {"method": request.method, "path": request.path,
                    "raw_path": request.raw_path, "headers": dict(request.headers),
                    "query": list(request.query.items())}
        self.requests.append(recorded)
        if request.path == "/ws":
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            try:
                await socket.send_str('{"type":"status","ready":true}')
                await socket.send_bytes(b"\x00\x00\x00\x01preview\x00\xff")
                async for message in socket:
                    self.ws_received.append((message.type, message.data))
                    if message.type == WSMsgType.TEXT:
                        if message.data == "close-upstream":
                            await socket.close()
                            break
                        await socket.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await socket.send_bytes(message.data)
            finally:
                self.ws_closed.set()
            return socket
        if request.path == "/upload/image":
            reader = await request.multipart()
            async for part in reader:
                self.uploads.append({"name": part.name, "filename": part.filename,
                                     "content_type": part.headers.get("Content-Type"),
                                     "bytes": bytes(await part.read())})
            return web.json_response({"name": "accepted.png", "type": "input"})
        recorded["body"] = await request.read()
        return web.Response(status=self.reply_status, body=self.reply_body,
                            headers=self.reply_headers)

    async def test_mobile_assets_status_and_saved_workflow_reads(self):
        boot = index_referenced_paths()
        self.assertIn("/mobile/assets/progress-sync.js", boot)
        self.assertEqual(index_script_paths(), [
            # i18n.js 是手机页与电脑端面板共用的同一份运行时
            "/mobile/assets/i18n.js",
            "/mobile/assets/preset-catalog.js",
            "/mobile/assets/preset-engine.js",
            "/mobile/assets/settings-sync.js",
            "/mobile/assets/progress-sync.js",
            "/mobile/assets/app.js",
        ])
        paths = ["/mobile", "/mobile/", *boot,
                 "/mobile/api/status", "/mobile/api/progress", "/mobile/api/workflows",
                 "/mobile/api/workflows/" + WORKFLOW_ID, "/mobile/api/jobs",
                 "/mobile/api/preview"]
        for path in paths:
            with self.subTest(path=path):
                async with self.client.get(self.base + path) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(await response.read(), self.reply_body)
                self.assertEqual(self.requests[-1]["path"], path)
        self.assertEqual(len(self.requests), len(paths))

    async def test_root_redirect_and_head_preserve_http_semantics(self):
        async with self.client.get(self.base + "/", allow_redirects=False) as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers["Location"], "/mobile")
        self.assertEqual(self.requests, [])
        async with self.client.head(self.base + "/mobile/assets/app.js") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_length, len(self.reply_body))
            self.assertEqual(await response.read(), b"")
        self.assertEqual(self.requests[-1]["method"], "HEAD")

    async def test_saved_job_submission_and_controls_preserve_json(self):
        payload = {"workflow_id": WORKFLOW_ID, "inputs": {"prompt": "\u6d4b\u8bd5 + / ?"},
                   "batch_count": 2, "client_id": "phone + 测试"}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        for path in ["/mobile/api/jobs", "/mobile/api/jobs/saved_job-01/cancel",
                     "/mobile/api/jobs/saved_job-01/retry"]:
            with self.subTest(path=path):
                async with self.client.post(self.base + path, data=body,
                                            headers={"Content-Type": "application/json"}) as response:
                    self.assertEqual(response.status, 200)
                    await response.read()
                self.assertEqual(self.requests[-1]["method"], "POST")
                forwarded = json.loads(self.requests[-1]["body"])
                self.assertEqual(forwarded["workflow_id"], payload["workflow_id"])
                self.assertEqual(forwarded["inputs"], payload["inputs"])
                self.assertEqual(forwarded["batch_count"], payload["batch_count"])
                self.assertEqual(forwarded["client_id"], self.gateway._transform_client_id(payload["client_id"]))

    async def test_rewritten_jobs_body_drops_any_content_length_casing(self):
        payload = {"workflow_id": WORKFLOW_ID, "client_id": "phone"}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        parsed = URL(self.base)
        request = (
            f"POST /mobile/api/jobs HTTP/1.1\r\n"
            f"Host: {parsed.host}:{parsed.port}\r\n"
            "Content-Type: application/json\r\n"
            f"CONTENT-LENGTH: {len(body)}\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("ascii") + body
        reader, writer = await asyncio.open_connection(parsed.host, parsed.port)
        writer.write(request)
        await writer.drain()
        await reader.read()
        writer.close()
        await writer.wait_closed()
        forwarded = self.requests[-1]
        self.assertEqual(json.loads(forwarded["body"])["client_id"],
                         self.gateway._transform_client_id("phone"))
        content_length = next((value for key, value in forwarded["headers"].items()
                               if key.lower() == "content-length"), None)
        if content_length is not None:
            self.assertEqual(int(content_length), len(forwarded["body"]))

    async def test_public_delete_does_not_remove_workflows(self):
        self.assertFalse(connections.public_path_allowed("DELETE", "/mobile/api/workflows/" + WORKFLOW_ID))
        async with self.client.delete(self.base + "/mobile/api/workflows/" + WORKFLOW_ID) as response:
            self.assertEqual(response.status, 404)
            await response.read()
        self.assertEqual(self.requests, [])

    async def test_editor_and_connection_control_routes_never_reach_upstream(self):
        paths = ["/prompt", "/object_info", "/extensions", "/mobile/api/connections",
                 "/mobile/api/connections/tunnel", "/mobile/api/workflows/sync",
                 "/mobile/api/drafts/" + WORKFLOW_ID]
        for path in paths:
            for method in ("GET", "POST"):
                with self.subTest(method=method, path=path):
                    async with self.client.request(method, self.base + path,
                                                   allow_redirects=False) as response:
                        self.assertEqual(response.status, 404)
                        await response.read()
        for method in ("PUT", "PATCH", "DELETE", "OPTIONS"):
            with self.subTest(method=method):
                async with self.client.request(method, self.base + "/mobile/api/jobs") as response:
                    self.assertEqual(response.status, 404)
                    await response.read()
        self.assertEqual(self.requests, [])

    async def test_encoded_and_traversal_route_bypasses_are_blocked(self):
        paths = ["/%6dobile/api/jobs", "/mobile/api/%63onnections",
                 "/mobile/api/%2563onnections", "/mobile/api/workflows/%73ync",
                 "/mobile/api/jobs%2f..%2fconnections",
                 "/mobile/assets/%2e%2e/%2e%2e/prompt",
                 "/mobile/assets/..%5c..%5cprompt", "/mobile/api/jobs/../connections"]
        for path in paths:
            with self.subTest(path=path):
                # encoded=True stops the HTTP client normalizing the attack before sending it.
                target = URL(self.base + path, encoded=True)
                async with self.client.post(target, allow_redirects=False) as response:
                    self.assertEqual(response.status, 404)
                    await response.read()
        self.assertEqual(self.requests, [])

    async def test_chinese_filename_query_and_range_bytes_are_unchanged(self):
        query = [("filename", "\u6d4b\u8bd5 \u56fe\u50cf+01.png"),
                 ("subfolder", "\u8f93\u51fa/\u4eca\u5929"), ("type", "output"),
                 ("marker", "+/?&= %"), ("marker", "second")]
        raw_path = "/view?" + urlencode(query)
        media = bytes(range(256)) * 1024
        self.reply_status = 206
        self.reply_body = media[17:131091]
        self.reply_headers = {"Content-Type": "image/png", "Accept-Ranges": "bytes",
                              "Content-Range": "bytes 17-131090/262144", "ETag": '"test-image"'}
        async with self.client.get(URL(self.base + raw_path, encoded=True),
                                   headers={"Range": "bytes=17-131090", "If-Range": '"test-image"'}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(await response.read(), self.reply_body)
            self.assertEqual(response.headers["Content-Range"], self.reply_headers["Content-Range"])
            self.assertEqual(response.headers["ETag"], '"test-image"')
        self.assertEqual(self.requests[-1]["raw_path"], raw_path)
        self.assertEqual(self.requests[-1]["query"], query)
        self.assertEqual(self.requests[-1]["headers"]["Range"], "bytes=17-131090")
        self.assertEqual(self.requests[-1]["headers"]["If-Range"], '"test-image"')

    async def test_view_allows_phone_input_output_temp_and_rejects_annotated_traversal(self):
        before = len(self.requests)
        for type_name in ("input", "output", "temp"):
            path = "/view?" + urlencode([("filename", "a.png"), ("subfolder", "mobile_remote"),
                                         ("type", type_name)])
            with self.subTest(allowed=type_name):
                async with self.client.get(self.base + path) as response:
                    self.assertEqual(response.status, 200)
                    await response.read()
        self.assertEqual(len(self.requests), before + 3)
        blocked = [
            "/view?" + urlencode({"filename": "secret.png", "type": "models"}),
            "/view?" + urlencode({"filename": "secret.png [input]", "type": "output"}),
            "/view?" + urlencode({"filename": "secret.png[temp]", "type": "output"}),
            "/view?" + urlencode({"filename": "../secret.png", "type": "output"}),
            "/view?" + urlencode({"filename": "secret.png", "subfolder": "../", "type": "output"}),
            "/view?" + urlencode({"filename": "blake3:abc", "type": "output"}),
            "/view?" + urlencode({"filename": "a/b.png", "type": "output"}),
        ]
        for path in blocked:
            with self.subTest(blocked=path):
                async with self.client.get(URL(self.base + path, encoded=True),
                                           allow_redirects=False) as response:
                    self.assertEqual(response.status, 404)
                    await response.read()
        self.assertEqual(len(self.requests), before + 3)

    async def test_public_status_strips_gpu_and_tailscale_fields(self):
        payload = {"ok": True, "online": True, "running": 1, "pending": 0,
                   "gpu": {"name": "secret-gpu", "total": 1}, "tailscale_ips": ["100.70.1.2"],
                   "mobile_urls": ["http://100.70.1.2:8188/mobile"], "version": "0.1.0"}
        self.reply_body = json.dumps(payload).encode("utf-8")
        self.reply_headers = {"Content-Type": "application/json"}
        async with self.client.get(self.base + "/mobile/api/status") as response:
            self.assertEqual(response.status, 200)
            body = await response.json()
        self.assertEqual(body["ok"], True)
        self.assertEqual(body["running"], 1)
        self.assertEqual(body["version"], "0.1.0")
        self.assertNotIn("gpu", body)
        self.assertNotIn("tailscale_ips", body)
        self.assertNotIn("mobile_urls", body)
        self.assertEqual(self.requests[-1]["path"], "/mobile/api/status")

    async def test_multipart_image_upload_preserves_filename_fields_and_binary_bytes(self):
        image = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 1100
        filename = "\u624b\u673a \u56fe\u7247+1.png"
        form = FormData(quote_fields=False)
        form.add_field("image", image, filename=filename, content_type="image/png")
        form.add_field("type", "input")
        form.add_field("overwrite", "false")
        async with self.client.post(self.base + "/upload/image", data=form) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"name": "accepted.png", "type": "input"})
        self.assertEqual(self.uploads[0], {"name": "image", "filename": filename,
                                           "content_type": "image/png", "bytes": image})
        self.assertEqual([(item["name"], item["bytes"]) for item in self.uploads[1:]],
                         [("type", b"input"), ("overwrite", b"false")])

    async def test_encoded_response_bytes_and_sensitive_headers(self):
        self.reply_body = gzip.compress(b"phone asset\x00\xff" * 100)
        self.reply_headers = {"Content-Type": "application/javascript", "Content-Encoding": "gzip",
                              "Connection": "X-Upstream-Only", "X-Upstream-Only": "private",
                              "Set-Cookie": "desktop_session=private", "Access-Control-Allow-Origin": "*",
                              "Access-Control-Allow-Credentials": "true", "ETag": '"asset-1"'}
        async with self.client.get(self.base + "/mobile/assets/app.js",
                                   headers={"Cookie": "desktop_session=secret",
                                            "Authorization": "Bearer secret",
                                            "X-Forwarded-Host": "other.invalid",
                                            "Accept-Encoding": "gzip"}) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), self.reply_body)
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertEqual(response.headers["ETag"], '"asset-1"')
            for header in ("Set-Cookie", "X-Upstream-Only", "Access-Control-Allow-Origin",
                           "Access-Control-Allow-Credentials"):
                self.assertNotIn(header, response.headers)
            self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        headers = self.requests[-1]["headers"]
        for header in ("Cookie", "Authorization", "X-Forwarded-Host"):
            self.assertNotIn(header, headers)
        self.assertEqual(headers["Accept-Encoding"], "gzip")

    async def test_upstream_redirect_is_not_followed(self):
        self.reply_status = 302
        self.reply_headers = {"Location": "/prompt"}
        async with self.client.get(self.base + "/mobile", allow_redirects=False) as response:
            self.assertEqual(response.status, 302)
            self.assertEqual(response.headers["Location"], "/prompt")
            await response.read()
        self.assertEqual(len(self.requests), 1)

    async def test_cross_origin_and_invalid_origins_are_denied_before_proxying(self):
        for origin in ["https://other.invalid", "null", "http://127.0.0.1:1",
                       "https://[", "file://127.0.0.1", "not-an-origin"]:
            for method, path in [("GET", "/mobile/api/status"), ("POST", "/mobile/api/jobs"),
                                 ("GET", "/ws")]:
                with self.subTest(origin=origin, method=method, path=path):
                    async with self.client.request(method, self.base + path,
                                                   headers={"Origin": origin}) as response:
                        self.assertEqual(response.status, 403)
                        await response.read()
        self.assertEqual(self.requests, [])

    async def test_same_authority_and_public_https_origins_are_allowed(self):
        cases = [{"Origin": self.base},
                 {"Host": "test-gateway.trycloudflare.com",
                  "Origin": "https://test-gateway.trycloudflare.com"}]
        for headers in cases:
            with self.subTest(headers=headers):
                async with self.client.post(self.base + "/mobile/api/jobs", json={"workflow_id": WORKFLOW_ID},
                                            headers=headers) as response:
                    self.assertEqual(response.status, 200)
                    await response.read()
        self.assertEqual(len(self.requests), 2)

    async def open_websocket(self):
        query = urlencode({"clientId": "phone + \u6d4b\u8bd5"})
        socket = await self.client.ws_connect(URL(self.base + "/ws?" + query, encoded=True),
                                              headers={"Origin": self.base})
        self.addAsyncCleanup(socket.close)
        self.assertEqual(await asyncio.wait_for(socket.receive_str(), WAIT),
                         '{"type":"status","ready":true}')
        self.assertEqual(await asyncio.wait_for(socket.receive_bytes(), WAIT),
                         b"\x00\x00\x00\x01preview\x00\xff")
        upstream_path = self.requests[-1]["raw_path"]
        self.assertRegex(upstream_path, r"^/ws\?clientId=mobile-gateway-[0-9a-f]{64}$")
        self.assertEqual(self.gateway._transform_client_id("phone + 测试"),
                         dict(self.requests[-1]["query"])["clientId"])
        self.assertNotIn("phone", upstream_path)
        return socket

    async def test_websocket_bridges_text_binary_and_client_disconnect(self):
        socket = await self.open_websocket()
        text = '{"event":"\u6d4b\u8bd5","value":"+/?"}'
        binary = bytes(range(256)) * 1024
        await socket.send_str(text)
        self.assertEqual(await asyncio.wait_for(socket.receive_str(), WAIT), text)
        await socket.send_bytes(binary)
        self.assertEqual(await asyncio.wait_for(socket.receive_bytes(), WAIT), binary)
        self.assertEqual(self.ws_received, [(WSMsgType.TEXT, text), (WSMsgType.BINARY, binary)])
        await socket.close()
        await asyncio.wait_for(self.ws_closed.wait(), WAIT)
        self.assertFalse(self.gateway.sockets)

    async def test_execution_error_scrubs_nested_data_and_keeps_binary_frames(self):
        socket = await self.open_websocket()
        error = {
            "type": "execution_error",
            "data": {"exception_message": "bad", "traceback": "secret", "current_inputs": {"x": 1},
                     "current_outputs": {"y": 2}, "node_id": "3"},
            "traceback": "outer-secret",
        }
        await socket.send_str(json.dumps(error, ensure_ascii=False))
        received = json.loads(await asyncio.wait_for(socket.receive_str(), WAIT))
        self.assertEqual(received["type"], "execution_error")
        self.assertEqual(received["data"], {"exception_message": "bad", "node_id": "3"})
        self.assertEqual(received["traceback"], "outer-secret")

        socket = await self.open_websocket()
        await socket.send_str("close-upstream")
        message = await asyncio.wait_for(socket.receive(), WAIT)
        self.assertIn(message.type, (WSMsgType.CLOSE, WSMsgType.CLOSED))
        await asyncio.wait_for(self.ws_closed.wait(), WAIT)

    async def test_gateway_shutdown_closes_both_websocket_ends_and_listener(self):
        socket = await self.open_websocket()
        shutdown = asyncio.create_task(self.gateway.close())
        try:
            message = await asyncio.wait_for(socket.receive(), WAIT)
            self.assertIn(message.type, (WSMsgType.CLOSE, WSMsgType.CLOSED))
            await asyncio.wait_for(shutdown, WAIT)
        finally:
            if not shutdown.done():
                shutdown.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await shutdown
        await asyncio.wait_for(self.ws_closed.wait(), WAIT)
        self.assertFalse(self.gateway.sockets)
        self.assertIsNone(self.gateway.runner)
        self.assertIsNone(self.gateway.session)
        self.assertEqual(self.gateway.url, "")
        await self.gateway.close()


class TailscaleDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.executable = str(Path(tempfile.gettempdir()) / "fake-tailscale.exe")
        self.which = self.enterContext(mock.patch.object(connections.shutil, "which",
                                                        return_value=self.executable))
        self.is_file = self.enterContext(mock.patch.object(connections.Path, "is_file", return_value=True))
        self.run = self.enterContext(mock.patch.object(connections.subprocess, "run"))
        self.clock = self.enterContext(mock.patch.object(connections.time, "monotonic", return_value=1000.0))

    def status(self, payload, returncode=0):
        self.run.return_value = subprocess.CompletedProcess([self.executable], returncode,
                                                             stdout=json.dumps(payload), stderr="")
        return connections.TailscaleDiscovery().get(8818)

    def test_absent_executable_is_unconfigured_without_spawning(self):
        self.which.return_value = None
        self.is_file.return_value = False
        result = connections.TailscaleDiscovery().get(8818)
        self.assertEqual(result["state"], "unconfigured")
        self.assertEqual(result["urls"], [])
        self.run.assert_not_called()

    def test_offline_and_unconfigured_json_statuses(self):
        for payload, state in [({"BackendState": "Stopped"}, "offline"),
                               ({"BackendState": "Starting"}, "offline"),
                               ({"BackendState": "Running", "Self": {"Online": False},
                                 "TailscaleIPs": ["100.70.1.2"]}, "offline"),
                               ({"BackendState": "NeedsLogin"}, "unconfigured")]:
            with self.subTest(payload=payload):
                result = self.status(payload)
                self.assertEqual(result["state"], state)
                self.assertEqual(result["urls"], [])

    def test_running_json_uses_only_unique_tailscale_ipv4_addresses(self):
        payload = {"BackendState": "Running", "Self": {"Online": True},
                   "TailscaleIPs": ["100.90.1.4", "fd7a:115c:a1e0::1", "100.70.1.2",
                                    "100.90.1.4", "192.168.1.8", "127.0.0.1", "203.0.113.1", "bad-ip"]}
        result = self.status(payload)
        self.assertEqual(result["state"], "connected")
        self.assertEqual(result["urls"], ["http://100.70.1.2:8818/mobile", "http://100.90.1.4:8818/mobile"])
        self.assertEqual(self.run.call_args.args[0], [self.executable, "status", "--json"])
        self.assertEqual(self.run.call_args.kwargs["timeout"], 3)

    def test_command_failure_timeout_and_bad_json_are_offline(self):
        self.assertEqual(self.status({}, returncode=1)["state"], "offline")
        for error in (FileNotFoundError("fixture"), subprocess.TimeoutExpired("tailscale", 3)):
            with self.subTest(error=type(error).__name__):
                self.run.side_effect = error
                result = connections.TailscaleDiscovery().get(8818)
                self.assertEqual(result["state"], "offline")
                self.assertEqual(result["urls"], [])
        self.run.side_effect = None
        for output in ("{bad json", "[]", "null"):
            with self.subTest(output=output):
                self.run.return_value = subprocess.CompletedProcess([], 0, stdout=output)
                self.assertEqual(connections.TailscaleDiscovery().get(8818)["state"], "offline")

    def test_polling_cache_expires_and_returns_independent_status_dict(self):
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout=json.dumps({"BackendState": "Stopped"}))
        discovery = connections.TailscaleDiscovery()
        first = discovery.get(8818)
        first["state"] = "changed-by-caller"
        self.assertEqual(discovery.get(8818)["state"], "offline")
        self.assertEqual(self.run.call_count, 1)
        self.clock.return_value += 16
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout=json.dumps(
            {"BackendState": "Running", "Self": {"Online": True}, "TailscaleIPs": ["100.70.1.2"]}))
        self.assertEqual(discovery.get(8818)["state"], "connected")
        self.assertEqual(self.run.call_count, 2)


class FakeSupervisor:
    """A cancellable runner with observable startup and deliberately gated cleanup."""
    def __init__(self):
        self.started = asyncio.Queue()
        self.stopping = asyncio.Queue()
        self.release_cleanup = asyncio.Event()
        self.release_cleanup.set()
        self.active = 0
        self.peak_active = 0
        self.starts = 0

    async def run(self):
        self.starts += 1
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        self.started.put_nowait(asyncio.current_task())
        try:
            await asyncio.Future()
        finally:
            self.stopping.put_nowait(asyncio.current_task())
            await self.release_cleanup.wait()
            self.active -= 1


class TunnelManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mobile-connections-tests-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # Any accidental transition into a real installer/process is a test failure.
        for target, name in [(connections, "install_binary"), (connections.subprocess, "Popen"),
                             (connections.urllib.request, "urlopen")]:
            self.enterContext(mock.patch.object(target, name,
                                                side_effect=AssertionError("real tunnel execution in test")))
        self.manager, self.supervisor = self.new_manager()

    def new_manager(self):
        manager = connections.TunnelManager("http://127.0.0.1:8818", 8818, root=self.root)
        supervisor = FakeSupervisor()
        self.enterContext(mock.patch.object(manager, "_supervise", new=supervisor.run))
        if not hasattr(self, "tailscale_status"):
            self.tailscale_status = {"state": "unconfigured", "urls": [], "message": ""}
        self.enterContext(mock.patch.object(manager.discovery, "get",
                                            side_effect=lambda port, fresh=False: dict(self.tailscale_status)))
        self.addAsyncCleanup(manager.shutdown, None)
        self.addCleanup(supervisor.release_cleanup.set)
        return manager, supervisor

    async def start(self, manager=None, supervisor=None):
        manager = manager or self.manager
        supervisor = supervisor or self.supervisor
        await manager.action("start")
        return await asyncio.wait_for(supervisor.started.get(), WAIT)

    async def test_concurrent_starts_share_one_runner_and_stop_is_idempotent(self):
        await asyncio.gather(*(self.manager.action("start") for _ in range(20)))
        first_task = await asyncio.wait_for(self.supervisor.started.get(), WAIT)
        self.assertTrue(self.manager.enabled)
        self.assertEqual(self.manager.state, "starting")
        self.assertEqual(self.supervisor.starts, 1)
        self.assertEqual(self.supervisor.active, 1)
        self.assertEqual(self.supervisor.peak_active, 1)
        self.manager.public_url = "https://fixture.invalid/mobile"
        await self.manager.action("stop")
        await self.manager.action("stop")
        self.assertTrue(first_task.done())
        self.assertEqual(self.supervisor.active, 0)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.manager.state, "stopped")
        self.assertEqual(self.manager.public_url, "")
        self.assertIsNone(self.manager._task)

    async def test_restart_waits_for_old_cleanup_without_duplicate_runner(self):
        old_task = await self.start()
        old_cancel = self.manager._cancel_download
        self.supervisor.release_cleanup.clear()
        restart = asyncio.create_task(self.manager.action("restart"))
        queued_start = None
        try:
            self.assertIs(await asyncio.wait_for(self.supervisor.stopping.get(), WAIT), old_task)
            queued_start = asyncio.create_task(self.manager.action("start"))
            await asyncio.sleep(0)
            self.assertFalse(restart.done())
            self.assertFalse(queued_start.done())
            self.assertTrue(old_cancel.is_set())
            self.assertEqual(self.supervisor.starts, 1)
        finally:
            self.supervisor.release_cleanup.set()
            await asyncio.wait_for(asyncio.gather(*[task for task in (restart, queued_start) if task]), WAIT)
        new_task = await asyncio.wait_for(self.supervisor.started.get(), WAIT)
        self.assertIsNot(new_task, old_task)
        self.assertTrue(old_task.done())
        self.assertEqual(self.supervisor.starts, 2)
        self.assertEqual(self.supervisor.active, 1)
        self.assertEqual(self.supervisor.peak_active, 1)
        self.assertFalse(self.manager._cancel_download.is_set())
        self.assertIsNot(self.manager._cancel_download, old_cancel)

    async def test_stop_then_start_creates_new_runner(self):
        first = await self.start()
        await self.manager.action("stop")
        second = await self.start()
        self.assertTrue(first.done())
        self.assertIsNot(first, second)
        self.assertEqual(self.supervisor.starts, 2)
        self.assertEqual(self.supervisor.peak_active, 1)

    async def test_settings_persist_and_startup_honors_disabled_autostart(self):
        self.assertTrue(self.manager.autostart)
        await self.manager.action("settings", autostart=False)
        settings_path = self.root / "remote_settings.json"
        self.assertEqual(json.loads(settings_path.read_text(encoding="utf-8")), {"autostart": False})
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 0)
        self.assertEqual(list(self.root.glob("*.tmp")), [])
        reloaded, supervisor = self.new_manager()
        self.assertFalse(reloaded.autostart)
        await reloaded.startup(None)
        self.assertIsNone(reloaded._task)
        self.assertEqual(supervisor.starts, 0)
        await reloaded.action("settings", autostart=True)
        enabled, enabled_supervisor = self.new_manager()
        self.assertTrue(enabled.autostart)
        await enabled.startup(None)
        await asyncio.wait_for(enabled_supervisor.started.get(), WAIT)
        self.assertEqual(enabled_supervisor.starts, 1)
        self.assertEqual(json.loads(settings_path.read_text(encoding="utf-8")), {"autostart": True})

    async def test_settings_change_does_not_restart_live_runner(self):
        task = await self.start()
        await self.manager.action("settings", autostart=False)
        self.assertIs(self.manager._task, task)
        self.assertTrue(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 1)
        self.assertFalse(self.manager.autostart)
        await self.manager.action("stop")
        self.assertFalse(self.manager.autostart)
        self.assertEqual(json.loads((self.root / "remote_settings.json").read_text(encoding="utf-8")),
                         {"autostart": False})

    async def test_failed_settings_write_keeps_previous_state_and_file(self):
        await self.manager.action("settings", autostart=False)
        before = (self.root / "remote_settings.json").read_bytes()
        with mock.patch.object(connections, "_atomic_json", side_effect=OSError("fixture write failure")):
            with self.assertRaises(OSError):
                await self.manager.action("start", autostart=True)
        self.assertFalse(self.manager.autostart)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 0)
        self.assertEqual((self.root / "remote_settings.json").read_bytes(), before)

    async def test_startup_skips_cloudflare_when_tailscale_is_online(self):
        self.tailscale_status = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        await self.manager.startup(None)
        self.assertIsNone(self.manager._task)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 0)
        self.assertEqual(self.manager.state, "stopped")
        self.assertEqual(self.manager.message, connections.TAILSCALE_SUPPRESSED)
        self.assertIsNotNone(self.manager._watch_task)

    async def test_startup_autostarts_cloudflare_when_tailscale_is_offline(self):
        self.tailscale_status = {"state": "offline", "urls": [], "message": ""}
        await self.manager.startup(None)
        await asyncio.wait_for(self.supervisor.started.get(), WAIT)
        self.assertEqual(self.supervisor.starts, 1)
        self.assertTrue(self.manager.enabled)

    async def test_start_refuses_cloudflare_while_tailscale_is_online(self):
        self.tailscale_status = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        await self.manager.action("start")
        self.assertIsNone(self.manager._task)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 0)
        self.assertEqual(self.manager.message, connections.TAILSCALE_SUPPRESSED)

    async def test_tailscale_online_during_cloudflare_start_stops_without_reconnect(self):
        started = await self.start()
        self.assertEqual(self.manager.state, "starting")
        self.tailscale_status = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        await self.manager._sync_cloudflare_with_tailscale()
        self.assertTrue(started.done())
        self.assertFalse(self.manager.enabled)
        self.assertIsNone(self.manager._task)
        self.assertEqual(self.manager.state, "stopped")
        self.assertEqual(self.manager.message, connections.TAILSCALE_SUPPRESSED)
        self.assertEqual(self.supervisor.starts, 1)

    async def test_cloudflare_starts_when_tailscale_goes_offline(self):
        self.tailscale_status = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        self.manager.watch_interval = 0.01
        await self.manager.startup(None)
        self.assertFalse(self.manager.enabled)
        self.tailscale_status = {"state": "offline", "urls": [], "message": ""}
        await asyncio.wait_for(self.supervisor.started.get(), WAIT)
        self.assertTrue(self.manager.enabled)
        self.assertEqual(self.supervisor.starts, 1)

    async def test_running_cloudflare_stops_when_tailscale_comes_online(self):
        await self.start()
        self.manager.watch_interval = 0.01
        await self.manager.startup(None)
        self.tailscale_status = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        await asyncio.sleep(0.05)
        deadline = time.monotonic() + WAIT
        while self.manager.enabled and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.manager.state, "stopped")
        self.assertEqual(self.manager.message, connections.TAILSCALE_SUPPRESSED)
        self.assertEqual(self.supervisor.starts, 1)

    async def test_tailscale_watch_round_uses_one_fresh_probe(self):
        await self.start()
        connected = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": ""}
        with mock.patch.object(self.manager.discovery, "get", side_effect=lambda port, fresh=False: dict(connected)) as discovery:
            await self.manager._sync_cloudflare_with_tailscale()
        self.assertEqual(discovery.call_args_list, [mock.call(8818, True)])
        self.assertFalse(self.manager.enabled)
        self.assertEqual(self.manager.state, "stopped")
        self.assertEqual(self.manager.message, connections.TAILSCALE_SUPPRESSED)

    async def test_snapshot_combines_local_and_mock_discovery_without_starting(self):
        tailscale = {"state": "connected", "urls": ["http://100.70.1.2:8818/mobile"], "message": "fixture"}
        with mock.patch.object(self.manager.discovery, "get", return_value=tailscale) as discovery, \
                mock.patch.object(connections, "find_binary", return_value=None):
            status = await self.manager.snapshot()
        discovery.assert_called_once_with(8818)
        self.assertTrue(status["ok"])
        self.assertEqual(status["local_url"], "http://127.0.0.1:8818/mobile")
        self.assertEqual(status["tailscale"], tailscale)
        self.assertEqual(status["tunnel"]["state"], "stopped")
        self.assertFalse(status["tunnel"]["binary_present"])
        self.assertEqual(self.supervisor.starts, 0)


@unittest.skipUnless(sys.platform == "win32", "Windows Job objects only")
class WindowsChildJobTests(unittest.TestCase):
    def test_force_exit_of_parent_kills_owned_sleeping_child(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.TerminateProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL

        worker = r'''
import ctypes
import importlib.util
import json
import os
import subprocess
import sys
from ctypes import wintypes

spec = importlib.util.spec_from_file_location("job_owner_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
                                  ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
                                  wintypes.BOOL, wintypes.DWORD]
kernel.DuplicateHandle.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(60)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
try:
    observer = kernel.OpenProcess(0x0040, False, os.getppid())
    if not observer:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        owned_handle = wintypes.HANDLE()
        if not kernel.DuplicateHandle(kernel.GetCurrentProcess(), child._handle, observer,
                                      ctypes.byref(owned_handle), 0, False, 2):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(observer)
    print(json.dumps({"pid": child.pid, "handle": owned_handle.value}), flush=True)
    job = module._WindowsChildJob(child)
except BaseException:
    child.kill()
    child.wait(timeout=5)
    raise
os._exit(0)
'''
        result = None
        try:
            result = subprocess.run([sys.executable, "-B", "-c", worker, str(MODULE_PATH)],
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    encoding="utf-8", timeout=10,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            output = result.stdout
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or b""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
        owned = json.loads(output.strip()) if output.strip() else {}
        # The worker duplicates this handle before exiting; PID reuse cannot affect cleanup.
        handle = owned.get("handle")
        try:
            self.assertIsNotNone(result, "disposable Job owner did not exit within 10 seconds")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(handle, "worker did not transfer its disposable child handle")
            self.assertEqual(kernel.WaitForSingleObject(handle, 3000), 0,
                             "owned child survived os._exit of its Job owner (PID {})".format(owned["pid"]))
        finally:
            if handle:
                if kernel.WaitForSingleObject(handle, 0) == 258:
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)


if __name__ == "__main__":
    unittest.main()
