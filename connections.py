"""Optional Quick Tunnel transport; ComfyUI's graphs and LAN listener stay separate."""
from __future__ import annotations

import asyncio
import atexit
import contextlib
import ctypes
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import tarfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web
from yarl import URL

LOG = logging.getLogger("comfyui.mobile_remote.connections")


def _t(text: str, **params: Any) -> str:
    """复用服务端的界面词典；本模块被单独加载（测试）时退回中文原文。"""
    try:
        from .server import _t as translate
    except ImportError:
        return text
    try:
        return translate(text, **params)
    except Exception:  # pragma: no cover - 翻译失败绝不能影响连接功能
        LOG.exception("[Mobile Remote] translation failed")
        return text
ROOT = Path(__file__).resolve().parent
TAILSCALE_SUPPRESSED = "Tailscale生效中，自动关闭 Cloudflare"
NO_CACHE = {"Cache-Control": "no-store"}
MAX_UPLOAD = 100 * 1024 * 1024
PUBLIC_URL = re.compile(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b")
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}
# accept-language 要带上：隧道里服务端只能靠它判断提示语用哪种语言。
# Cookie 依旧不转发（公网入口不接受任何凭据，见敏感请求头测试）。
REQUEST_HEADERS = {"content-type", "content-length", "accept", "accept-encoding", "range",
                   "if-range", "if-none-match", "if-modified-since", "accept-language"}
GET_PATHS = (
    r"/mobile/?", r"/mobile/manifest\.webmanifest",
    r"/mobile/assets/(?:app\.js|i18n\.js|settings-sync\.js|preset-catalog\.js|preset-engine\.js|progress-sync\.js|styles\.css|icon\.svg|prompt-presets\.json)",
    r"/mobile/api/(?:status|settings|progress|workflows|jobs|favorites/file|preview|i18n/[a-z]{2})",
    r"/mobile/api/workflows/[a-f0-9]{20}",
    r"/mobile/api/jobs/[A-Za-z0-9_-]{1,128}", r"/view", r"/ws",
)
POST_PATHS = (
    r"/mobile/api/(?:settings|jobs|favorites/toggle|outputs/delete)",
    r"/mobile/api/jobs/[A-Za-z0-9_-]{1,128}/(?:cancel|retry)", r"/upload/image",
)
VIEW_TYPES = {"input", "output", "temp"}
STATUS_PUBLIC_DROP = ("gpu", "tailscale_ips", "mobile_urls")


def public_path_allowed(method: str, path: str, raw_path: str = "") -> bool:
    # Route paths are ASCII. Media filenames belong in query parameters.
    if "%" in raw_path.split("?", 1)[0] or "\\" in path:
        return False
    patterns = GET_PATHS if method in {"GET", "HEAD"} else POST_PATHS if method == "POST" else ()
    return any(re.fullmatch(pattern, path) for pattern in patterns)


def _unsafe_path_part(value: str) -> bool:
    text = str(value or "")
    if not text:
        return False
    return ".." in text or text.startswith(("/", "\\")) or ":" in text or "\x00" in text


def public_view_allowed(query) -> bool:
    """Phone LoadImage needs type=input; annotated names and traversal must not pass."""
    filename = str(query.get("filename", "") or "")
    subfolder = str(query.get("subfolder", "") or "")
    type_name = str(query.get("type", "output") or "output")
    if not filename or type_name not in VIEW_TYPES:
        return False
    if filename.startswith("blake3:"):
        return False
    if filename.endswith(("[output]", "[input]", "[temp]")):
        return False
    if _unsafe_path_part(filename) or "/" in filename or "\\" in filename:
        return False
    if _unsafe_path_part(subfolder):
        return False
    return True


def _same_host(origin: str | None, host: str) -> bool:
    if not origin:
        return True
    try:
        parsed = URL(origin)
        return parsed.scheme in {"http", "https"} and parsed.raw_authority == host
    except ValueError:
        return False


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class TailscaleDiscovery:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._at = 0.0
        self._cached: dict[str, Any] = {}

    def get(self, port: int, fresh: bool = False) -> dict[str, Any]:
        with self._lock:
            if not fresh and time.monotonic() - self._at < 15 and self._cached:
                return self._cached.copy()
            candidates = [shutil.which("tailscale")]
            if os.name == "nt":
                candidates.append(str(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tailscale" / "tailscale.exe"))
            else:
                candidates.extend(["/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"])
            executable = next((item for item in candidates if item and Path(item).is_file()), None)
            result: dict[str, Any] = {"state": "unconfigured", "urls": [],
                                     "message": "配置 Tailscale 后显示链接。请在电脑和手机加入同一个 Tailscale 网络。"}
            if executable:
                try:
                    process = subprocess.run([executable, "status", "--json"], capture_output=True,
                                             text=True, encoding="utf-8", errors="replace", timeout=3,
                                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    data = json.loads(process.stdout) if process.returncode == 0 else {}
                    if not isinstance(data, dict):
                        raise ValueError("Tailscale status is not an object")
                    self_info = data.get("Self") or {}
                    if not isinstance(self_info, dict):
                        self_info = {}
                    backend = data.get("BackendState")
                    if process.returncode != 0:
                        result.update(state="offline", message="Tailscale 服务尚未连接，启动后显示链接。")
                    elif backend == "Running" and self_info.get("Online") is not False:
                        ips = []
                        for value in data.get("TailscaleIPs", []):
                            with contextlib.suppress(ValueError):
                                address = ipaddress.ip_address(value)
                                if address.version == 4 and address in ipaddress.ip_network("100.64.0.0/10"):
                                    ips.append(str(address))
                        if ips:
                            result = {"state": "connected", "urls": [f"http://{ip}:{port}/mobile" for ip in sorted(set(ips))],
                                      "message": "电脑和手机的 Tailscale 保持在线，即可使用此链接。"}
                    elif backend in {"Stopped", "Starting", "Running"}:
                        result.update(state="offline", message="Tailscale 已断开，连接后显示链接。")
                except (OSError, subprocess.SubprocessError, ValueError):
                    result.update(state="offline", message="Tailscale 尚未连接，启动并配置后显示链接。")
            self._cached, self._at = result, time.monotonic()
            return result.copy()


def _asset_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    architecture = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64",
                    "x86": "386", "i386": "386", "i686": "386"}.get(machine)
    if system == "windows" and architecture == "arm64":
        architecture = "amd64"  # Windows on ARM supports x64 emulation.
    if not architecture or system not in {"windows", "linux", "darwin"}:
        raise RuntimeError("当前系统需要手动安装 cloudflared，并放入 PATH。")
    suffix = ".exe" if system == "windows" else ".tgz" if system == "darwin" else ""
    return f"cloudflared-{system}-{architecture}{suffix}"


def find_binary(root: Path = ROOT) -> Path | None:
    bundled = root / "bin" / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if bundled.is_file():
        return bundled
    installed = shutil.which("cloudflared")
    return Path(installed) if installed else None


def install_binary(root: Path, cancelled: threading.Event) -> Path:
    """Download an official release, verify its digest, then publish atomically."""
    existing = find_binary(root)
    if existing:
        return existing
    name = _asset_name()
    request = urllib.request.Request("https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
                                     headers={"User-Agent": "ComfyUI-Mobile-Remote", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=25) as response:
        release = json.load(response)
    asset = next((item for item in release.get("assets", []) if item.get("name") == name), None)
    if not asset:
        raise RuntimeError("官方暂未提供当前系统的穿透组件。")
    expected = str(asset.get("digest", ""))
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected):
        raise RuntimeError("官方组件缺少 SHA256 校验值，请稍后重试。")
    download_url = asset.get("browser_download_url", "")
    if not download_url.startswith("https://github.com/cloudflare/cloudflared/releases/download/"):
        raise RuntimeError("官方组件下载地址异常。")
    directory = root / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f".cloudflared-{uuid.uuid4().hex}.download"
    executable = directory / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    extracted = temporary.with_suffix(".extracted")
    checksum = hashlib.sha256()
    received = 0
    try:
        request = urllib.request.Request(download_url, headers={"User-Agent": "ComfyUI-Mobile-Remote"})
        with urllib.request.urlopen(request, timeout=30) as source, temporary.open("wb") as destination:
            while chunk := source.read(256 * 1024):
                if cancelled.is_set():
                    raise RuntimeError("组件下载已取消。")
                received += len(chunk)
                if received > 150 * 1024 * 1024:
                    raise RuntimeError("组件大小异常。")
                checksum.update(chunk)
                destination.write(chunk)
        if received != asset.get("size") or checksum.hexdigest() != expected.removeprefix("sha256:"):
            raise RuntimeError("穿透组件校验失败，请重新下载。")
        if cancelled.is_set():
            raise RuntimeError("组件下载已取消。")
        candidate = temporary
        if name.endswith(".tgz"):
            with tarfile.open(temporary, "r:gz") as archive:
                member = next((item for item in archive.getmembers()
                               if Path(item.name).name == "cloudflared" and item.isfile()), None)
                if member is None or member.size > 150 * 1024 * 1024:
                    raise RuntimeError("组件压缩包内容异常。")
                with archive.extractfile(member) as source, extracted.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
            candidate = extracted
        candidate.chmod(0o755)
        os.replace(candidate, executable)
        _atomic_json(directory / "release.json", {"version": release.get("tag_name"), "asset": name, "digest": expected})
        return executable
    finally:
        temporary.unlink(missing_ok=True)
        extracted.unlink(missing_ok=True)


class _WindowsChildJob:
    """Kill the owned cloudflared even when a launcher force-kills ComfyUI."""
    def __init__(self, process: subprocess.Popen) -> None:
        from ctypes import wintypes as w

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", w.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount",
                         "WriteTransferCount", "OtherTransferCount")]

        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IO),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.kernel.AssignProcessToJobObject(self.handle, w.HANDLE(process._handle)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class MobileGateway:
    def __init__(self, origin: str) -> None:
        self.origin = origin.rstrip("/")
        self.runner: web.AppRunner | None = None
        self.session: ClientSession | None = None
        self.sockets: set[web.WebSocketResponse] = set()
        self.url = ""
        self._client_id_secret = secrets.token_bytes(32)

    def _transform_client_id(self, client_id: Any) -> str:
        """Map one caller id to a stable, gateway-owned ComfyUI namespace."""
        raw = str(client_id or "")[:128]
        digest = hmac.new(self._client_id_secret, raw.encode("utf-8", errors="replace"), hashlib.sha256).hexdigest()
        return f"mobile-gateway-{digest}"

    async def _rewrite_client_id_body(self, request: web.Request) -> bytes | None:
        """Rewrite only JSON jobs bodies; multipart and malformed bodies pass through."""
        if request.content_type != "application/json":
            return None
        raw = await request.read()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return raw
        if not isinstance(payload, dict) or "client_id" not in payload:
            return raw
        payload["client_id"] = self._transform_client_id(payload.get("client_id"))
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    async def start(self) -> str:
        self.session = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10, sock_read=180),
                                     auto_decompress=False, trust_env=False)
        app = web.Application(client_max_size=MAX_UPLOAD)
        app.router.add_route("*", "/{path:.*}", self.handle)
        self.runner = web.AppRunner(app, access_log=None, shutdown_timeout=3)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.url = f"http://127.0.0.1:{port}"
        return self.url

    async def close(self) -> None:
        if self.sockets:
            await asyncio.gather(*(item.close(code=1001) for item in list(self.sockets)), return_exceptions=True)
        if self.runner:
            await self.runner.cleanup()
            self.runner = None
        if self.session:
            await self.session.close()
            self.session = None
        self.url = ""

    async def _body(self, request: web.Request):
        count = 0
        async for chunk in request.content.iter_chunked(64 * 1024):
            count += len(chunk)
            if count > MAX_UPLOAD:
                raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=count)
            yield chunk

    async def handle(self, request: web.Request) -> web.StreamResponse:
        if request.path == "/" and request.method in {"GET", "HEAD"}:
            raise web.HTTPFound("/mobile")
        if not public_path_allowed(request.method, request.path, request.raw_path):
            raise web.HTTPNotFound()
        if request.path == "/view" and not public_view_allowed(request.query):
            raise web.HTTPNotFound()
        # Cross-site control requests do not need CORS on this single-origin UI.
        origin = request.headers.get("Origin")
        if not _same_host(origin, request.host):
            raise web.HTTPForbidden()
        if request.content_length and request.content_length > MAX_UPLOAD:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=request.content_length)
        if request.path == "/ws":
            return await self._websocket(request)
        headers = {key.lower(): value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS}
        if request.path == "/mobile/api/status":
            headers = {key: value for key, value in headers.items() if key != "accept-encoding"}
        target = URL(self.origin + request.raw_path, encoded=True)
        response = None
        try:
            body = None
            if request.can_read_body:
                jobs_json = request.method == "POST" and request.path.startswith("/mobile/api/jobs")
                if jobs_json:
                    body = await self._rewrite_client_id_body(request)
                    if body is None:
                        body = self._body(request)
                    else:
                        headers.pop("content-length", None)
                else:
                    body = self._body(request)
            async with self.session.request(request.method, target, headers=headers,
                                            data=body,
                                            allow_redirects=False) as upstream:
                if request.path == "/mobile/api/status":
                    return await self._public_status(request, upstream)
                forbidden = HOP_HEADERS | {"set-cookie", "access-control-allow-origin", "access-control-allow-credentials"}
                forbidden |= {name.strip().lower() for name in upstream.headers.get("Connection", "").split(",")}
                outgoing = {key: value for key, value in upstream.headers.items() if key.lower() not in forbidden}
                outgoing.update({"Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive"})
                response = web.StreamResponse(status=upstream.status, headers=outgoing)
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response
        except web.HTTPException:
            raise
        except (ClientError, ConnectionError, asyncio.TimeoutError, OSError) as exc:
            if response is not None and response.prepared:
                response.force_close()
                return response
            raise web.HTTPBadGateway(text=_t("电脑端连接暂时中断，请稍后重试。")) from exc

    async def _public_status(self, request: web.Request, upstream) -> web.Response:
        raw = await upstream.read()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            payload = None
        if isinstance(payload, dict):
            for key in STATUS_PUBLIC_DROP:
                payload.pop(key, None)
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        forbidden = HOP_HEADERS | {"set-cookie", "access-control-allow-origin", "access-control-allow-credentials",
                                   "content-length", "content-encoding"}
        forbidden |= {name.strip().lower() for name in upstream.headers.get("Connection", "").split(",")}
        outgoing = {key: value for key, value in upstream.headers.items() if key.lower() not in forbidden}
        outgoing.update({"Content-Type": "application/json; charset=utf-8",
                         "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive"})
        if request.method == "HEAD":
            return web.Response(status=upstream.status, headers=outgoing)
        return web.Response(status=upstream.status, body=raw, headers=outgoing)

    async def _websocket(self, request: web.Request) -> web.WebSocketResponse:
        downstream = web.WebSocketResponse(heartbeat=30, max_msg_size=32 * 1024 * 1024)
        query = dict(request.rel_url.query)
        query["clientId"] = self._transform_client_id(query.get("clientId", ""))
        upstream_url = URL(self.origin + "/ws").with_query(query)
        async with self.session.ws_connect(upstream_url,
                                           heartbeat=30, max_msg_size=32 * 1024 * 1024) as upstream:
            await downstream.prepare(request)
            self.sockets.add(downstream)

            async def relay(source, destination):
                async for message in source:
                    if message.type == WSMsgType.TEXT:
                        data = message.data
                        try:
                            payload = json.loads(data)
                            if isinstance(payload, dict) and payload.get("type") == "execution_error":
                                data_payload = payload.get("data")
                                if isinstance(data_payload, dict):
                                    for key in ("traceback", "current_inputs", "current_outputs"):
                                        data_payload.pop(key, None)
                                    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                        except (TypeError, ValueError):
                            pass
                        await destination.send_str(data)
                    elif message.type == WSMsgType.BINARY:
                        await destination.send_bytes(message.data)
                    elif message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                        break

            tasks = [asyncio.create_task(relay(upstream, downstream)), asyncio.create_task(relay(downstream, upstream))]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                self.sockets.discard(downstream)
                await downstream.close()
        return downstream


def tailscale_online(status: dict[str, Any] | None) -> bool:
    return isinstance(status, dict) and status.get("state") == "connected"


class TunnelManager:
    def __init__(self, origin: str, port: int, root: Path = ROOT) -> None:
        self.origin, self.port, self.root = origin, port, root
        self.settings_path = root / "remote_settings.json"
        self.runtime = root / ".runtime"
        self.autostart = True
        try:
            settings = json.loads(self.settings_path.read_text(encoding="utf-8"))
            self.autostart = settings.get("autostart", True) is True
        except (OSError, ValueError, AttributeError):
            pass
        self.enabled = False
        self.state, self.message, self.public_url = "stopped", "公网连接已关闭。", ""
        self.discovery = TailscaleDiscovery()
        self._task: asyncio.Task | None = None
        self._control = asyncio.Lock()
        self._cancel_download = threading.Event()
        self._process: subprocess.Popen | None = None
        self._job: _WindowsChildJob | None = None
        self._gateway: MobileGateway | None = None
        self._watch_task: asyncio.Task | None = None
        self.watch_interval = 4.0
        atexit.register(self._kill_owned_process)

    async def snapshot(self) -> dict[str, Any]:
        tailscale = await asyncio.to_thread(self.discovery.get, self.port)
        return {"ok": True, "local_url": self.origin + "/mobile",
                "tunnel": {"state": self.state, "url": self.public_url, "message": self.message,
                           "autostart": self.autostart, "enabled": self.enabled,
                           "binary_present": find_binary(self.root) is not None}, "tailscale": tailscale}

    def _set_state(self, state: str, message: str, url: str = "") -> None:
        self.state, self.message, self.public_url = state, message, url

    def _kill_owned_process(self) -> None:
        self._cancel_download.set()
        if self._process is not None and self._process.poll() is None:
            with contextlib.suppress(OSError):
                self._process.kill()
        if self._job:
            self._job.close()
            self._job = None

    async def _cleanup_process(self) -> None:
        process = self._process
        if process is not None:
            if process.poll() is None:
                with contextlib.suppress(OSError):
                    process.terminate()
            try:
                await asyncio.to_thread(process.wait, timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait, timeout=3)
            self._process = None
        if self._job:
            self._job.close()
            self._job = None

    async def _stop(self) -> None:
        self.enabled = False
        self._cancel_download.set()
        self._kill_owned_process()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._set_state("stopped", "公网连接已关闭。")

    async def action(self, action: str, autostart: bool | None = None) -> None:
        async with self._control:
            if autostart is not None:
                await asyncio.to_thread(_atomic_json, self.settings_path, {"autostart": autostart})
                self.autostart = autostart
            if action in {"stop", "restart"}:
                await self._stop()
            if action in {"start", "restart"} and (self._task is None or self._task.done()):
                tailscale = await asyncio.to_thread(self.discovery.get, self.port, True)
                if tailscale_online(tailscale):
                    self.enabled = False
                    self._set_state("stopped", TAILSCALE_SUPPRESSED)
                    return
                self.enabled = True
                self._cancel_download = threading.Event()
                self._set_state("starting", "正在建立临时公网连接…")
                self._task = asyncio.create_task(self._supervise(), name="mobile-quick-tunnel")

    async def startup(self, _app: web.Application) -> None:
        if self._watch_task is None or self._watch_task.done():
            self._watch_task = asyncio.create_task(self._watch_tailscale(), name="mobile-tailscale-watch")
        tailscale = await asyncio.to_thread(self.discovery.get, self.port, True)
        if tailscale_online(tailscale):
            self._set_state("stopped", TAILSCALE_SUPPRESSED)
            return
        if self.autostart:
            await self.action("start")

    async def shutdown(self, _app: web.Application) -> None:
        if self._watch_task is not None:
            self._watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watch_task
            self._watch_task = None
        await self.action("stop")
        atexit.unregister(self._kill_owned_process)

    def _tunnel_running(self) -> bool:
        return self.enabled or (self._task is not None and not self._task.done())

    async def _abort_if_tailscale_online(self) -> bool:
        tailscale = await asyncio.to_thread(self.discovery.get, self.port, True)
        if not tailscale_online(tailscale):
            return False
        self.enabled = False
        self._cancel_download.set()
        self._set_state("stopped", TAILSCALE_SUPPRESSED)
        return True

    async def _sync_cloudflare_with_tailscale(self) -> None:
        # One fresh probe per watch round is enough; a second subprocess here
        # only rechecked the same result and could add seconds to every poll.
        tailscale = await asyncio.to_thread(self.discovery.get, self.port, True)
        if tailscale_online(tailscale):
            async with self._control:
                if not self._tunnel_running():
                    if self.message != TAILSCALE_SUPPRESSED:
                        self._set_state("stopped", TAILSCALE_SUPPRESSED)
                    return
                await self._stop()
                self._set_state("stopped", TAILSCALE_SUPPRESSED)
            return
        if not self.autostart or self._tunnel_running():
            return
        await self.action("start")

    async def _watch_tailscale(self) -> None:
        while True:
            try:
                await self._sync_cloudflare_with_tailscale()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.debug("[Mobile Remote] Tailscale watch failed", exc_info=True)
            await asyncio.sleep(self.watch_interval)

    async def _supervise(self) -> None:
        attempts = 0
        try:
            while self.enabled:
                attempts += 1
                try:
                    if await self._abort_if_tailscale_online():
                        return
                    if find_binary(self.root) is None:
                        self._set_state("installing", "首次连接正在下载穿透组件，完成后会自动连接…")
                    executable = await asyncio.to_thread(install_binary, self.root, self._cancel_download)
                    if not self.enabled or self._cancel_download.is_set() or await self._abort_if_tailscale_online():
                        return
                    self._set_state("starting", "正在建立临时公网连接…")
                    self._gateway = MobileGateway(self.origin)
                    gateway_url = await self._gateway.start()
                    if await self._abort_if_tailscale_online():
                        return
                    await self._run_tunnel(executable, gateway_url)
                    if self.enabled:
                        self._set_state("reconnecting", "公网连接已中断，正在自动重连…")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if not self.enabled:
                        return
                    LOG.warning("[Mobile Remote] public connection failed: %s", exc)
                    self._set_state("error", "公网连接暂未成功，正在自动重试。也可继续使用 Tailscale。")
                finally:
                    await self._cleanup_process()
                    if self._gateway:
                        await self._gateway.close()
                        self._gateway = None
                if not self.enabled:
                    return
                await asyncio.sleep(min(5 * attempts, 60))
        finally:
            await self._cleanup_process()
            if self._gateway:
                await self._gateway.close()
                self._gateway = None

    async def _run_tunnel(self, executable: Path, gateway_url: str) -> None:
        self.runtime.mkdir(parents=True, exist_ok=True)
        config = self.runtime / "quick-tunnel.yml"
        config.write_text("{}\n", encoding="utf-8")
        log_path = self.runtime / "cloudflared.log"
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            metrics_port = probe.getsockname()[1]
        args = [str(executable), "tunnel", "--config", str(config), "--no-autoupdate", "--url", gateway_url,
                "--protocol", "http2", "--edge-ip-version", "4", "--metrics", f"127.0.0.1:{metrics_port}",
                "--loglevel", "info"]
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("TUNNEL_")}
        with log_path.open("wb") as output:
            self._process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                             cwd=self.runtime, env=environment,
                                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if os.name == "nt":
                self._job = _WindowsChildJob(self._process)
            base_url = ""
            last_ready = time.monotonic()
            was_ready = False
            async with ClientSession(timeout=ClientTimeout(total=3), trust_env=False) as health:
                with log_path.open("r", encoding="utf-8", errors="replace") as log:
                    while self.enabled and self._process.poll() is None:
                        if await self._abort_if_tailscale_online():
                            return
                        text = log.read(256 * 1024)
                        match = PUBLIC_URL.search(text)
                        if match:
                            base_url = match.group(0)
                        ready = False
                        if base_url:
                            try:
                                async with health.get(f"http://127.0.0.1:{metrics_port}/ready") as response:
                                    ready = response.status == 200
                                if ready:
                                    async with health.get(self.origin + "/mobile") as response:
                                        ready = response.status == 200
                            except Exception:
                                ready = False
                        if ready:
                            last_ready = time.monotonic()
                            was_ready = True
                            self._set_state("connected", "临时公网连接已建立，手机浏览器可直接打开。", base_url + "/mobile")
                        elif was_ready:
                            self._set_state("reconnecting", "公网连接暂时中断，正在自动重连…")
                        if time.monotonic() - last_ready > 120:
                            self._set_state("reconnecting", "连接超时，正在重新申请临时链接…")
                            break
                        await asyncio.sleep(2)


def register_connections(prompt_server) -> TunnelManager:
    from comfy.cli_args import args

    port = int(args.port)
    listeners = str(args.listen or "127.0.0.1").split(",")
    host = "127.0.0.1"
    if not any(item in {"0.0.0.0", "127.0.0.1", "localhost"} for item in listeners):
        host = "[::1]" if "::" in listeners or "::1" in listeners else listeners[0]
    manager = TunnelManager(f"http://{host}:{port}", port)
    routes = prompt_server.routes

    @routes.get("/mobile/api/connections")
    async def connections_status(_request: web.Request):
        return web.json_response(await manager.snapshot(), headers=NO_CACHE)

    @routes.post("/mobile/api/connections/tunnel")
    async def connections_action(request: web.Request):
        # Desktop calls send JSON; browsers cannot mutate this endpoint with a cross-origin form.
        if request.content_type != "application/json" or request.headers.get("Sec-Fetch-Site") == "cross-site":
            return web.json_response({"ok": False, "error": _t("请从电脑端连接面板操作。")}, status=403, headers=NO_CACHE)
        origin = request.headers.get("Origin")
        try:
            if not _same_host(origin, request.host):
                raise ValueError("origin")
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("object")
            action = payload.get("action")
            if action not in {"start", "stop", "restart", "settings"}:
                raise ValueError("action")
            autostart = payload.get("autostart")
            if autostart is not None and not isinstance(autostart, bool):
                raise ValueError("autostart")
        except (ValueError, web.HTTPException):
            return web.json_response({"ok": False, "error": _t("连接设置格式有误。")}, status=400, headers=NO_CACHE)
        try:
            await manager.action(action, autostart)
        except OSError:
            LOG.exception("[Mobile Remote] failed to save connection settings")
            return web.json_response({"ok": False, "error": _t("连接设置保存失败，请检查插件目录权限。")}, status=500, headers=NO_CACHE)
        return web.json_response(await manager.snapshot(), headers=NO_CACHE)

    prompt_server.app.on_startup.append(manager.startup)
    prompt_server.app.on_cleanup.append(manager.shutdown)
    return manager
