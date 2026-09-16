from __future__ import annotations

import asyncio
import contextvars
import copy
import gzip
import hashlib
import ipaddress
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import threading
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from aiohttp import web

PLUGIN_ROOT = Path(__file__).resolve().parent
MOBILE_ROOT = PLUGIN_ROOT / "mobile"
# 界面词典：手机页、电脑端面板和服务端提示共用同一份，避免三处各翻一套。
I18N_ROOT = PLUGIN_ROOT / "i18n"
# 中文是源码里的原文（也是词典的键），所以不需要 zh.json。
MOBILE_LOCALES = ("zh", "en", "ja", "ko")
FALLBACK_LOCALE = "en"
LOCALE_COOKIE = "mtr_locale"  # 手机页与电脑端面板都会写，服务端据此翻译提示语
WORKFLOW_ROOT = PLUGIN_ROOT / "workflows"
DRAFT_ROOT = PLUGIN_ROOT / "drafts"
HISTORY_INDEX_PATH = PLUGIN_ROOT / "mobile_history.json"
FAVORITES_PATH = PLUGIN_ROOT / "mobile_favorites.json"
FAVORITE_FILES = PLUGIN_ROOT / "favorite_files"
FAVORITE_META_NAME = "job.json"
FAVORITE_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
HISTORY_MAX_ITEMS = 500
HISTORY_SYNC_INTERVAL = 15.0
NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate"}
GZIP_MIN_BYTES = 1024   # 小于这个体积就不值得压：gzip 头 + 手机端解压开销比省下的还多
MEDIA_CACHE = {"Cache-Control": "private, max-age=86400"}
LOG = logging.getLogger("comfyui.mobile_remote")
ROUTES_REGISTERED = False
TAILSCALE_CACHE: tuple[float, list[str]] = (0.0, [])
_TAILSCALE_LOCK = threading.Lock()
_PREVIEW_LOCK = threading.Lock()
_UPDATE_LOCK = threading.Lock()
_HISTORY_CACHE: dict[str, dict[str, Any]] = {}
_HISTORY_LOCK = threading.Lock()
_HISTORY_SYNC_LOCK = threading.Lock()
_HISTORY_LOADED = False
_HISTORY_TIMER_STARTED = False
_FAVORITES: set[tuple[str, str, str, str]] = set()
_FAVORITES_LOCK = threading.Lock()
_FAVORITE_TOGGLE_LOCK = threading.Lock()
_FAVORITES_LOADED = False

# 缩略图列表缓存：同一份历史条目 + 同一版收藏状态只算一次。
# /mobile/api/jobs 每次要给几百条历史建缩略图，逐个查磁盘是最大的开销之一。
FAVORITE_META_BACKFILL_INTERVAL = 60.0   # 收藏元数据兜底回填的最小间隔（秒）
HISTORY_PERSIST_INTERVAL = 30.0          # 历史索引落盘的最小间隔（秒）
_FAVORITE_META_BACKFILL_AT = 0.0
_HISTORY_PERSIST_AT = 0.0

_GALLERY_CACHE: dict[str, tuple[Any, int, list[dict[str, str]]]] = {}
_GALLERY_CACHE_LIMIT = 1500
_GALLERY_REVISION = 0


def _bump_gallery_revision() -> None:
    """收藏状态、图片删除、过期清理改变缩略图归属时，让缓存失效。"""
    global _GALLERY_REVISION
    _GALLERY_REVISION += 1

SENSITIVE_INPUT_NAMES = {
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
}

LABELS = {
    "text": "提示词",
    "prompt": "提示词",
    "positive": "正向提示词",
    "positive_prompt": "正向提示词",
    "negative": "反向提示词",
    "negative_prompt": "反向提示词",
    "image": "输入图片",
    "ckpt_name": "基础模型",
    "model_name": "模型",
    "unet_name": "模型",
    "clip_name": "文本编码器",
    "weight_dtype": "权重类型",
    "device": "设备",
    "type": "类型",
    "lora_name": "LoRA",
    "vae_name": "VAE",
    "width": "宽度",
    "height": "高度",
    "batch_size": "批量数量",
    "seed": "种子",
    "noise_seed": "噪声种子",
    "steps": "采样步数",
    "cfg": "CFG",
    "denoise": "重绘幅度",
    "sampler_name": "采样器",
    "scheduler": "调度器",
    "filename_prefix": "输出文件名",
}

BASIC_INPUTS = {
    "text",
    "prompt",
    "positive",
    "positive_prompt",
    "negative",
    "negative_prompt",
    "image",
    "ckpt_name",
    "model_name",
    "width",
    "height",
    "batch_size",
    "unet_name",
    "model",
    "positive_text",
    "negative_text",
}

FIELD_ORDER = {
    "positive": 10,
    "positive_prompt": 10,
    "prompt": 10,
    "text": 15,
    "negative": 20,
    "negative_prompt": 20,
    "image": 30,
    "width": 50,
    "height": 51,
    "batch_size": 55,
    "ckpt_name": 60,
    "model_name": 60,
    "unet_name": 60,
    "lora_name": 62,
    "seed": 80,
    "noise_seed": 81,
    "steps": 100,
    "cfg": 101,
    "denoise": 102,
    "sampler_name": 103,
    "scheduler": 104,
}


# 当前请求的语言：中间件按请求设置，后台线程读到的就是默认值（中文）。
_REQUEST_LANG: contextvars.ContextVar[str] = contextvars.ContextVar("mobile_remote_lang", default="zh")


@lru_cache(maxsize=16)
def _locale_catalog(lang: str) -> dict[str, str]:
    """读取某个语言的界面词典；任何异常都退回空词典（也就是中文原文）。"""
    if lang not in MOBILE_LOCALES or lang == "zh":
        return {}
    path = I18N_ROOT / f"{lang}.json"
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        LOG.exception("[Mobile Remote] locale dictionary unreadable: %s", path)
        return {}
    if not isinstance(data, dict):
        return {}
    return {key: value for key, value in data.items() if isinstance(key, str) and isinstance(value, str)}


def _t(text: str, **params: Any) -> str:
    """把中文原文翻成当前请求语言；查不到就原样返回，占位符用 {name} 代入。"""
    template = _locale_catalog(_REQUEST_LANG.get()).get(text, text)
    if not params:
        return template
    try:
        return template.format(**params)
    except (KeyError, IndexError, ValueError):
        # 译文里的花括号坏掉了也不能让接口 500：退回中文原文。
        return text


def _accept_language(header: str) -> str:
    """从 Accept-Language 里挑第一个我们支持的语言。"""
    for chunk in str(header or "").split(","):
        tag = chunk.split(";")[0].strip().lower().replace("_", "-")
        primary = tag.split("-")[0]
        if primary in MOBILE_LOCALES:
            return primary
    return "zh"


def _request_locale(request: web.Request) -> str:
    """语言优先取 cookie（用户在面板里选过），否则按浏览器默认语言。"""
    cookie = str(request.cookies.get(LOCALE_COOKIE) or "").strip().lower()
    if cookie in MOBILE_LOCALES:
        return cookie
    return _accept_language(request.headers.get("Accept-Language", ""))


@web.middleware
async def _locale_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    """给每个请求绑定语言，后面的 _t() 才能翻出用户看得懂的提示。"""
    token = _REQUEST_LANG.set(_request_locale(request))
    try:
        return await handler(request)
    finally:
        _REQUEST_LANG.reset(token)


def _install_locale_middleware(server: Any) -> None:
    """挂载语言中间件；挂不上最多是提示语不翻译，绝不能让面板起不来。"""
    middlewares = getattr(getattr(server, "app", None), "middlewares", None)
    if middlewares is None or not hasattr(middlewares, "append"):
        LOG.warning("[Mobile Remote] aiohttp app unavailable; locale middleware skipped")
        return
    if _locale_middleware in middlewares:
        return
    try:
        middlewares.append(_locale_middleware)
    except RuntimeError:
        LOG.warning("[Mobile Remote] app already started; locale middleware skipped")


def _json_error(message: str, status: int = 400, details: Any = None) -> web.Response:
    payload: dict[str, Any] = {"ok": False, "error": _t(message)}
    if details is not None:
        payload["details"] = details
    return web.json_response(payload, status=status, headers=NO_CACHE)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("JSON root must be an object")
    return value


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def _record_path(workflow_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{20}", workflow_id):
        raise ValueError("Invalid workflow id")
    return WORKFLOW_ROOT / f"{workflow_id}.json"


def _draft_path(workflow_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{20}", workflow_id):
        raise ValueError("Invalid workflow id")
    return DRAFT_ROOT / f"{workflow_id}.json"


def _load_record(workflow_id: str) -> dict[str, Any]:
    path = _record_path(workflow_id)
    if not path.is_file():
        raise FileNotFoundError(workflow_id)
    return _read_json(path)


# ---- 版本检测 ----------------------------------------------------------
UPDATE_REPO = "Zonex313/comfyUI-Mobile-Remote"
# 不用 GitHub API：未认证的 API 每小时只给 60 次，代理 IP 还是共享的，很容易 403。
# 直接读仓库里的版本文件，走 raw 域名，没有这个限制。
UPDATE_VERSION_URL = f"https://raw.githubusercontent.com/{UPDATE_REPO}/master/pyproject.toml"
UPDATE_TTL_MS = 6 * 60 * 60 * 1000
UPDATE_CACHE: dict[str, Any] = {"at": 0, "data": None}


def _plugin_version() -> str:
    try:
        text = (PLUGIN_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        match = re.search(r'version\s*=\s*"([^"]+)"', text)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "0.0.0"


def _version_key(value: Any) -> tuple[int, ...]:
    parts = [int(item) for item in re.findall(r"\d+", str(value or ""))]
    return tuple(parts[:3]) if parts else (0,)


def _version_newer(latest: Any, current: Any) -> bool:
    return _version_key(latest) > _version_key(current)


def _system_proxy() -> str:
    """ComfyUI 自带的 python 不读系统代理，这里从注册表取一次。"""
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if not enabled:
                return ""
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
    except Exception:
        return ""
    server = str(server or "").strip()
    if not server:
        return ""
    if "=" in server:  # 形如 http=host:port;https=host:port
        parts = dict(item.split("=", 1) for item in server.split(";") if "=" in item)
        server = parts.get("https") or parts.get("http") or ""
    if not server:
        return ""
    return server if "://" in server else f"http://{server}"


# 更新时永远不碰这些：个人数据与运行产物
UPDATE_SKIP_NAMES = {
    "mobile_settings.json",
    "mobile_settings.json.bak",
    "mobile_history.json",
    "mobile_favorites.json",
    "remote_settings.json",
    ".runtime",
    "favorite_files",
    "workflows",
    "drafts",
    "__pycache__",
    ".git",
    ".github",
}


def _download_update_zip(url: str) -> Path:
    import tempfile
    import urllib.request

    request = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-Mobile-Remote"})
    proxy = _system_proxy()
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)
    target = Path(tempfile.mkdtemp(prefix="mobile-update-")) / "release.zip"
    with opener.open(request, timeout=120) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return target


def _update_plan(archive_path: Path) -> dict[str, Any]:
    """解压到临时目录并算出"会替换什么、会跳过什么"。只读，不碰插件目录。"""
    import tempfile
    import zipfile

    work = Path(tempfile.mkdtemp(prefix="mobile-update-x-"))
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(work)
    children = [child for child in work.iterdir() if child.is_dir()]
    root = children[0] if len(children) == 1 else work
    replace: list[str] = []
    skip: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if rel.parts[0] in UPDATE_SKIP_NAMES or rel.name in UPDATE_SKIP_NAMES:
            skip.append(rel.as_posix())
        else:
            replace.append(rel.as_posix())
    return {"work": work, "root": root, "replace": replace, "skip": skip}


UPDATE_BACKUP_KEEP = 2
# 只有这些后缀才允许被"删除旧文件"逻辑清理，避免误删
UPDATE_SAFE_SUFFIXES = {".py", ".js", ".css", ".html", ".toml", ".md", ".json", ".txt", ".svg", ".yml", ".yaml"}


def _apply_update_and_prune(source_root: Path, target_root: Path, backup_root: Path) -> dict[str, Any]:
    with _UPDATE_LOCK:
        result = _apply_update_files(source_root, target_root, backup_root)
        if result.get("ok"):
            try:
                _prune_backups()
            except OSError:
                LOG.exception("[Mobile Remote] failed to prune update backups")
        return result


def _prune_backups() -> int:
    """备份只保留最近 UPDATE_BACKUP_KEEP 份，其余删掉。"""
    root = PLUGIN_ROOT / ".runtime"
    if not root.is_dir():
        return 0
    backups = sorted(
        (path for path in root.glob("backup-*") if path.is_dir()),
        key=lambda path: path.name,
        reverse=True,
    )
    removed = 0
    for stale in backups[UPDATE_BACKUP_KEEP:]:
        shutil.rmtree(stale, ignore_errors=True)
        removed += 1
    return removed


def _apply_update_files(source_root: Path, target_root: Path, backup_root: Path) -> dict[str, Any]:
    """把 source_root 里的项目文件覆盖到 target_root，先整目录备份。

    任何一步失败都会用备份把 target_root 还原回去。
    个人数据不在归档里，也不会被碰。
    """
    copied: list[str] = []
    removed: list[str] = []
    backup_root.mkdir(parents=True, exist_ok=True)
    restored = False
    try:
        for path in sorted(target_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(target_root)
            if rel.parts[0] in UPDATE_SKIP_NAMES or rel.name in UPDATE_SKIP_NAMES:
                continue
            destination = backup_root / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        source_files: set[str] = set()
        for path in sorted(source_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(source_root)
            if rel.parts[0] in UPDATE_SKIP_NAMES or rel.name in UPDATE_SKIP_NAMES:
                continue
            source_files.add(rel.as_posix())
            destination = target_root / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            copied.append(rel.as_posix())
        # 新版里删掉的文件，本地也要删掉：只处理归档里有的顶层目录 + 安全后缀
        source_dirs = {name.split("/", 1)[0] for name in source_files}
        for path in sorted(target_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(target_root)
            if rel.parts[0] in UPDATE_SKIP_NAMES or rel.name in UPDATE_SKIP_NAMES:
                continue
            if rel.parts[0] not in source_dirs:
                continue
            if path.suffix.lower() not in UPDATE_SAFE_SUFFIXES:
                continue
            if rel.as_posix() not in source_files:
                path.unlink()
                removed.append(rel.as_posix())
    except Exception:
        LOG.exception("[Mobile Remote] update failed, rolling back")
        try:
            for path in sorted(backup_root.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(backup_root)
                destination = target_root / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
            restored = True
        except Exception:
            LOG.exception("[Mobile Remote] rollback failed")
        return {"ok": False, "copied": copied, "removed": removed, "restored": restored, "error": "更新失败，已尝试回滚"}
    return {"ok": True, "copied": copied, "removed": removed, "restored": False, "error": ""}


def _fetch_remote_version() -> str:
    import urllib.request

    request = urllib.request.Request(
        UPDATE_VERSION_URL,
        headers={"User-Agent": "ComfyUI-Mobile-Remote", "Cache-Control": "no-cache"},
    )
    proxy = _system_proxy()
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)
    with opener.open(request, timeout=20) as response:
        text = response.read().decode("utf-8", errors="replace")
    match = re.search(r'version\s*=\s*"([^"]+)"', text)
    if not match:
        raise ValueError("远端版本文件格式不对")
    return match.group(1)


# 电脑端"当前打开着哪个工作流"的标记；超时未收到心跳就当作已关闭。
ACTIVE_WORKFLOW_PATH = PLUGIN_ROOT / ".runtime" / "active_workflow.json"
ACTIVE_WORKFLOW_TTL_MS = 60000


def _open_workflow_sources() -> set[str] | None:
    """电脑端当前打开着的工作流来源集合；None = 标记失效（当作全关）。"""
    try:
        data = _read_json(ACTIVE_WORKFLOW_PATH)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    stamped = int(data.get("at") or 0)
    if (time.time() * 1000 - stamped) > ACTIVE_WORKFLOW_TTL_MS:
        return None
    sources = data.get("sources")
    if not isinstance(sources, list):
        return None
    return {str(item) for item in sources if isinstance(item, str) and item}


def _remember_open_source(source: str) -> None:
    """把刚同步的工作流来源并入"打开集合"，避免刚同步就被过滤掉。"""
    if not source:
        return
    current = _open_workflow_sources() or set()
    current.add(source)
    try:
        _write_json_atomic(
            ACTIVE_WORKFLOW_PATH, {"sources": sorted(current), "at": int(time.time() * 1000)}
        )
    except OSError:
        LOG.debug("[Mobile Remote] open workflow marker not written")


# 「没保存就同步」产生的垃圾工作流：名字里带 Unsaved Workflow 的一律不收，见到就删。
BLOCKED_WORKFLOW_NAME = re.compile(r"unsaved\s*workflow", re.IGNORECASE)


def _blocked_workflow_name(name: Any) -> bool:
    return bool(BLOCKED_WORKFLOW_NAME.search(str(name or "")))


def _purge_blocked_records() -> int:
    """删除目录里所有名字被拉黑的工作流记录，返回删除条数。"""
    WORKFLOW_ROOT.mkdir(parents=True, exist_ok=True)
    removed = 0
    for path in WORKFLOW_ROOT.glob("*.json"):
        try:
            record = _read_json(path)
        except Exception:
            continue
        if not _blocked_workflow_name(record.get("name")):
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            LOG.warning("[Mobile Remote] failed to remove blocked workflow %s", path)
    return removed


def _list_records(include_hidden: bool = False) -> list[dict[str, Any]]:
    WORKFLOW_ROOT.mkdir(parents=True, exist_ok=True)
    _purge_blocked_records()
    records: list[dict[str, Any]] = []
    for path in WORKFLOW_ROOT.glob("*.json"):
        try:
            record = _read_json(path)
            prompt = record.get("prompt", {})
            fields = _infer_fields(prompt)
            records.append(
                {
                    "id": record.get("id", path.stem),
                    "name": record.get("name", "未命名工作流"),
                    "source": record.get("source", ""),
                    "synced_at": record.get("synced_at", 0),
                    "node_count": len(prompt) if isinstance(prompt, dict) else 0,
                    "field_count": len(fields),
                    "has_prompt": any(field["kind"] == "textarea" for field in fields),
                    "has_image": any(field["kind"] == "image" for field in fields),
                    "pinned": bool(record.get("pinned")),
                    "library_path": str(record.get("library_path") or ""),
                }
            )
        except Exception as exc:
            LOG.warning("[Mobile Remote] ignoring unreadable workflow %s: %s", path, exc)
    if include_hidden:
        # 电脑端导入卡片要看全部记录（含没常驻的），才知道哪些工作流已经导入过
        records.sort(key=lambda item: (item.get("name", ""), item.get("id", "")))
        return records
    # 手机读两类工作流：电脑端当前打开着的，和电脑端手动导入的"常驻"工作流。
    # 常驻的电脑端全关也一直显示；其余打开几个显示几个，全部关掉就只剩常驻的。
    open_sources = _open_workflow_sources() or set()
    records = [
        item
        for item in records
        if item.get("pinned") or item.get("source") in open_sources
    ]
    # 常驻排前面，同组内新的在前
    records.sort(
        key=lambda item: (item.get("pinned", False), item.get("synced_at", 0), item.get("name", "")),
        reverse=True,
    )
    return records


def _existing_record(workflow_id: str) -> dict[str, Any]:
    """读旧记录，用于覆盖时保留人工标记；读不到就当空记录。"""
    try:
        return _load_record(workflow_id)
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _carry_over_flags(record: dict[str, Any]) -> None:
    """覆盖同名记录时，保住「常驻」这类人工标记。"""
    existing = _existing_record(str(record.get("id") or ""))
    for key in ("pinned", "pinned_at", "imported_at", "library_path"):
        if not record.get(key) and existing.get(key):
            record[key] = existing[key]


def _record_from_payload(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """把电脑端提交的工作流载荷校验成一条记录；错误时返回 (None, 错误文案)。

    工作流编号由「工作流自带的 id → 来源路径 → 名字」依次决定，和电脑端自动同步
    用的是同一套规则，所以「先导入、之后又在电脑端打开」会更新同一条记录，不会重复。
    """
    prompt = payload.get("prompt")
    workflow = payload.get("workflow")
    if not isinstance(prompt, dict) or not prompt:
        return None, "当前工作流没有可执行节点"
    if not all(isinstance(node, dict) and "class_type" in node for node in prompt.values()):
        return None, "需要 ComfyUI API 格式的工作流"
    if not isinstance(workflow, dict):
        workflow = {}

    raw_name = str(payload.get("name") or workflow.get("name") or "当前工作流").strip()
    name = re.sub(r"[\x00-\x1f]", "", raw_name)[:120] or "当前工作流"
    source = re.sub(r"[\x00-\x1f]", "", str(payload.get("source") or workflow.get("id") or name))[:500]
    identity = str(workflow.get("id") or source or name)
    workflow_id = hashlib.sha256(identity.encode("utf-8", errors="replace")).hexdigest()[:20]
    record: dict[str, Any] = {
        "schema": 1,
        "id": workflow_id,
        "name": name,
        "source": source,
        "synced_at": int(time.time() * 1000),
        "prompt": prompt,
        "workflow": workflow,
    }
    library_path = re.sub(r"[\x00-\x1f]", "", str(payload.get("library_path") or ""))[:500]
    if library_path:
        record["library_path"] = library_path
    return record, ""


def _stop_all_jobs(queue: Any) -> tuple[int, bool]:
    """先清空排队中的任务，再中断正在执行的那一个，返回（清掉几条, 是否中断成功）。

    顺序绝不能反：先中断的话，队列里的下一条会立刻开始执行，
    紧接着的清队列就会把它一起清掉——用户点一次按钮本意是「全部停下」。
    """
    running, pending = queue.get_current_queue_volatile()
    removed = len(pending)
    if removed:
        queue.delete_queue_item(lambda item: True)
    interrupted = False
    for item in running:
        if queue.interrupt_if_running(item[1]):
            interrupted = True
            break
    return removed, interrupted


def _node_center(node: dict[str, Any]) -> tuple[float, float]:
    """原生图里节点的中心点：有 size 用 size，没有就按 ComfyUI 默认节点尺寸估。"""
    pos = node.get("pos")
    if not isinstance(pos, (list, tuple)) or len(pos) < 2:
        return (0.0, 0.0)
    try:
        x = float(pos[0])
        y = float(pos[1])
    except (TypeError, ValueError):
        return (0.0, 0.0)
    size = node.get("size")
    width, height = 210.0, 100.0
    if isinstance(size, (list, tuple)) and len(size) >= 2:
        try:
            width = float(size[0])
            height = float(size[1])
        except (TypeError, ValueError):
            pass
    return (x + width / 2, y + height / 2)


def _inside_bounding(center: tuple[float, float], bounding: Any) -> float:
    """点在组框内时返回框面积，否则返回 0（面积用来挑最内层组）。"""
    if not isinstance(bounding, (list, tuple)) or len(bounding) < 4:
        return 0.0
    try:
        x, y, width, height = (float(value) for value in bounding[:4])
    except (TypeError, ValueError):
        return 0.0
    if width <= 0 or height <= 0:
        return 0.0
    if x <= center[0] <= x + width and y <= center[1] <= y + height:
        return width * height
    return 0.0


def _workflow_graph(prompt: Any, workflow: Any, fields: list[dict[str, Any]]) -> dict[str, Any]:
    """给手机端「高级」页用的节点图：节点顺序、分组、连线关系。

    节点来自 API 格式的 prompt（class_type + inputs，连线就是 [节点, 槽位]），
    分组与画布坐标来自原生图的 groups/nodes：按节点中心是否落在组框内判断，
    落在多个组里时取面积最小的那个（也就是最内层），和电脑端看到的一致。

    每个节点还带上 inputs：把该节点在 prompt 里出现的**所有**输入都列出来（连被
    NODE_HIDDEN_INPUTS 藏掉、fields 里没有的也在内），类型/候选值/范围直接来自节点类
    自己的 INPUT_TYPES()，这样「高级」页就能和电脑画布上的节点一一对应。
    另外补上前端专有控件（frontend=true，例如种子模式 control_after_generate）：
    它们不在 API prompt 里，值只能从原生图的 widgets_values 定位。
    """
    if not isinstance(prompt, dict):
        prompt = {}
    editable = {str(field.get("id", "")): field for field in fields if field.get("id")}
    native_nodes: dict[str, dict[str, Any]] = {}
    native_groups: list[dict[str, Any]] = []
    if isinstance(workflow, dict):
        nodes = workflow.get("nodes")
        if isinstance(nodes, list):
            for node in nodes:
                if isinstance(node, dict) and node.get("id") is not None:
                    native_nodes[str(node["id"])] = node
        groups = workflow.get("groups")
        if isinstance(groups, list):
            native_groups = [group for group in groups if isinstance(group, dict)]

    group_of: dict[str, str] = {}
    group_list: list[dict[str, Any]] = []
    for index, group in enumerate(native_groups):
        # 兜底标题用英文：中文写进 f-string 会被 i18n 抽取器当成待翻译 key，
        # 而插值后的这条字符串运行时永远不会被查表（users 看到的是「组 1」这种）。
        title = str(group.get("title") or group.get("name") or "").strip() or f"Group {index + 1}"
        bounding = group.get("bounding")
        members: list[str] = []
        for node_id in prompt.keys():
            native = native_nodes.get(str(node_id))
            if native is None:
                continue
            area = _inside_bounding(_node_center(native), bounding)
            if area <= 0:
                continue
            current = group_of.get(str(node_id))
            if current is None or area < current[1]:
                group_of[str(node_id)] = (title, area)  # type: ignore[assignment]
            members.append(str(node_id))
        group_list.append({
            "id": f"g{index}",
            "title": title,
            "color": str(group.get("color") or ""),
            "node_ids": members,
        })
    # 上面按「面积最小」记录，最后统一取标题
    resolved_group: dict[str, str] = {}
    for node_id, value in group_of.items():
        resolved_group[node_id] = value[0] if isinstance(value, tuple) else str(value)

    nodes_out: list[dict[str, Any]] = []
    schema_memo: dict[str, dict[str, dict[str, Any]]] = {}
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        key = str(node_id)
        native = native_nodes.get(key, {})
        pos = native.get("pos") if isinstance(native.get("pos"), list) else None
        meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        class_type = str(node.get("class_type") or "")
        specs = schema_memo.get(class_type)
        if specs is None:
            specs = _input_specs(class_type)
            schema_memo[class_type] = specs
        links = []
        inputs_out: list[dict[str, Any]] = []
        # 前端专有控件（种子模式）：API prompt 里没有，值只能从原生图的 widgets_values 拿
        frontend_controls = _frontend_control_entries(specs, native_nodes.get(key), inputs)
        for name, value in inputs.items():
            if isinstance(value, (list, tuple)) and len(value) == 2 and isinstance(value[0], (str, int)):
                links.append({"name": str(name), "node": str(value[0]), "slot": int(value[1]) if str(value[1]).isdigit() else 0})
            input_name = str(name)
            linked = _is_link(value, prompt)
            # 输入顺序就是 prompt 里的顺序：和画布上的槽位顺序一致，前端照抄即可。
            entry: dict[str, Any] = {
                "name": input_name,
                # 被连线接管的输入，值没有意义（前端只读显示连线来源），别把 ["4", 0] 这种数组丢过去。
                "value": None if linked else value,
            }
            entry.update(_input_descriptor(specs.get(input_name)))
            if linked:
                entry["link"] = {"node": str(value[0]), "slot": int(value[1])}
            inputs_out.append(entry)
            # 紧跟在 seed / noise_seed 后面：画布上它就在那儿（frontend=true，不参与提交）
            control = frontend_controls.get(input_name)
            if control is not None:
                inputs_out.append(dict(control))
        nodes_out.append({
            "id": key,
            "type": class_type,
            "title": str(meta.get("title") or node.get("class_type") or key),
            "pos": [int(pos[0]), int(pos[1])] if isinstance(pos, list) and len(pos) >= 2 else None,
            "group": resolved_group.get(key, ""),
            "links": links,
            "inputs": inputs_out,
            "field_ids": [field_id for field_id in editable if editable[field_id].get("node_id") == key],
            "has_editable": any(editable[field_id].get("node_id") == key for field_id in editable),
        })
    # 画布阅读顺序：先上后下、同一行内先左后右；没有坐标的排在最后（按 id）。
    def sort_key(node: dict[str, Any]) -> tuple:
        pos = node.get("pos")
        if not isinstance(pos, list) or len(pos) < 2:
            return (1, 0, 0, str(node["id"]))
        return (0, round(pos[1] / 40), pos[0], str(node["id"]))

    nodes_out.sort(key=sort_key)
    return {"nodes": nodes_out, "groups": group_list}


def _tailscale_ips() -> list[str]:
    global TAILSCALE_CACHE
    with _TAILSCALE_LOCK:
        now = time.monotonic()
        if now - TAILSCALE_CACHE[0] < 60:
            return list(TAILSCALE_CACHE[1])

        executables = ["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"]
        found: list[str] = []
        for executable in executables:
            try:
                result = subprocess.run(
                    [executable, "ip", "-4"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if result.returncode != 0:
                    continue
                for line in result.stdout.splitlines():
                    candidate = line.strip()
                    try:
                        address = ipaddress.ip_address(candidate)
                    except ValueError:
                        continue
                    if address.version == 4 and address in ipaddress.ip_network("100.64.0.0/10"):
                        found.append(candidate)
                if found:
                    break
            except (OSError, subprocess.SubprocessError):
                continue

        TAILSCALE_CACHE = (now, sorted(set(found)))
        return list(TAILSCALE_CACHE[1])


# 节点类的输入声明：INPUT_TYPES() 有的要现扫模型/插件目录，很贵，按 class_type 缓存。
# 缓存里只放「类确实找到了」的结果；类还没登记（启动早期）或 INPUT_TYPES() 抛异常时
# 返回空表且不缓存，等节点都挂上以后再问一次就能对上。
_INPUT_SPECS_CACHE: dict[str, dict[str, dict[str, Any]]] = {}
_INPUT_SPECS_LOCK = threading.Lock()


def _input_specs(class_type: str) -> dict[str, dict[str, Any]]:
    key = str(class_type or "")
    if not key:
        return {}
    cached = _INPUT_SPECS_CACHE.get(key)
    if cached is not None:
        return cached
    specs = _read_input_specs(key)
    if specs is None:
        return {}
    with _INPUT_SPECS_LOCK:
        _INPUT_SPECS_CACHE.setdefault(key, specs)
        return _INPUT_SPECS_CACHE[key]


def _read_input_specs(class_type: str) -> dict[str, dict[str, Any]] | None:
    """直接问节点类要 INPUT_TYPES()；类不存在或读不出来时返回 None（调用方不缓存）。"""
    try:
        import nodes

        node_class = nodes.NODE_CLASS_MAPPINGS.get(class_type)
        if node_class is None:
            return None
        raw = node_class.INPUT_TYPES()
    except Exception:
        return None

    specs: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return specs
    for section in ("required", "optional"):
        section_data = raw.get(section, {})
        if not isinstance(section_data, dict):
            continue
        for name, spec in section_data.items():
            token: Any = None
            config: dict[str, Any] = {}
            if isinstance(spec, (list, tuple)) and spec:
                token = spec[0]
                if len(spec) > 1 and isinstance(spec[1], dict):
                    config = spec[1]
            else:
                token = spec
            options: list[Any] = []
            if isinstance(token, (list, tuple, set)) and not isinstance(token, str):
                # 老式写法 (["a", "b"], {...})：候选值就是那个 list。
                options = [item for item in token if isinstance(item, (str, int, float, bool))]
                type_name = "COMBO"
            else:
                type_name = getattr(token, "value", None) or str(token or "")
                if str(type_name).upper() in {"COMBO", "ENUM"}:
                    # 新式写法 ("COMBO", {"options": [...]})：候选值在 config 里。
                    configured = config.get("options")
                    if isinstance(configured, (list, tuple)):
                        options = [item for item in configured if isinstance(item, (str, int, float, bool))]
            specs[str(name)] = {
                "required": section == "required",
                "type": str(type_name).upper(),
                "options": options,
                "config": config,
            }
    return specs


_UNSET = object()


def _value_type_hint(value: Any) -> str:
    """没拿到节点声明时，按当前值的 Python 类型猜一个。

    自制节点在测试进程里不一定登记在 NODE_CLASS_MAPPINGS 上，没有这层兜底
    就会把 true 这种开关值写成字符串 "True"。
    """
    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, int):
        return "INT"
    if isinstance(value, float):
        return "FLOAT"
    return "STRING"


def _input_descriptor(spec: Any, current: Any = _UNSET) -> dict[str, Any]:
    """INPUT_TYPES() 的一条声明 → 手机端 schema：type/options/min/max/step/multiline。

    只放这个输入确实有的键：COMBO 才给 options，INT/FLOAT 才给 min/max/step，
    STRING 且声明了 multiline 才给 multiline。查不到节点类时退化成 STRING。
    """
    data = spec if isinstance(spec, dict) else {}
    config = data.get("config")
    if not isinstance(config, dict):
        config = {}
    type_name = str(data.get("type") or "")
    if not type_name:
        type_name = "STRING" if current is _UNSET else _value_type_hint(current)
    descriptor: dict[str, Any] = {"type": type_name}
    if type_name == "COMBO":
        options = data.get("options")
        descriptor["options"] = [item for item in options] if isinstance(options, (list, tuple)) else []
    elif type_name in {"INT", "FLOAT"}:
        for name in ("min", "max", "step"):
            configured = config.get(name)
            if isinstance(configured, (int, float)) and not isinstance(configured, bool):
                descriptor[name] = configured
    elif type_name == "STRING" and bool(config.get("multiline")):
        descriptor["multiline"] = True
    return descriptor


# 前端专有控件：电脑画布上有，API prompt 里没有，值只在原生图的 widgets_values 里。
# 目前只做种子模式 control_after_generate（跟着 seed / noise_seed 后面那一格）。
CONTROL_WIDGET_NAME = "control_after_generate"
CONTROL_WIDGET_OPTIONS = ("fixed", "increment", "decrement", "randomize")
CONTROL_WIDGET_DEFAULT = "randomize"
SEED_INPUT_NAMES = frozenset({"seed", "noise_seed"})
# 画布上会变成控件的类型；MODEL/CLIP/IMAGE 这类只能连线的没有控件，不占 widgets_values 的格子。
WIDGET_INPUT_TYPES = frozenset({"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"})


def _seed_control_slot(name: str, config: dict[str, Any]) -> bool:
    """这个控件后面还有没有一格「种子模式」。节点自己声明了 control_after_generate 就听它的，
    没声明才按名字（seed / noise_seed）当成有——和电脑端前端建控件的规则一致。"""
    declared = config.get("control_after_generate")
    if declared is not None:
        return bool(declared)
    return name in SEED_INPUT_NAMES


def _widget_slot_names(specs: dict[str, dict[str, Any]], include_forced: bool) -> list[str]:
    """按 INPUT_TYPES 顺序排出画布上的控件槽位，顺序和 widgets_values 一一对应。"""
    slots: list[str] = []
    for name, spec in specs.items():
        if not isinstance(spec, dict):
            continue
        if str(spec.get("type") or "") not in WIDGET_INPUT_TYPES:
            continue
        config = spec.get("config")
        if not isinstance(config, dict):
            config = {}
        if not include_forced and bool(config.get("forceInput")):
            # forceInput 的输入在画布上没有控件，老流程存的 widgets_values 里却可能留着它的值，
            # 所以两种排法都试（见 _frontend_control_entries）。
            continue
        slots.append(name)
        if _seed_control_slot(name, config):
            slots.append(CONTROL_WIDGET_NAME)
    return slots


def _frontend_control_entries(
    specs: dict[str, dict[str, Any]],
    native_node: Any,
    inputs: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """给「有 seed 的节点」补一条前端专有的种子模式控件，键 = 它跟着的那个输入名。

    widgets_values 是纯位置数组，只有槽位数量能对上才敢用：数量不一致就说明这个 class
    在画布上的控件排布和我们理解的不一样（前端扩展插了控件、老工作流存过脏数据……），
    此时宁可不插（宁可少一个控件，也不能把别的控件的值当成种子模式显示）。
    唯一的例外是数组正好停在种子那一格（老工作流没存这个控件），此时按默认值 randomize 补。
    """
    if not specs or not isinstance(native_node, dict):
        return {}
    widgets_values = native_node.get("widgets_values")
    if not isinstance(widgets_values, list):
        return {}
    fallback: dict[str, dict[str, Any]] = {}
    for include_forced in (False, True):
        slots = _widget_slot_names(specs, include_forced)
        aligned = len(slots) == len(widgets_values)
        entries = _control_entries_from_slots(slots, widgets_values, inputs, aligned)
        if entries and aligned:
            return entries
        if entries and not fallback:
            fallback = entries
    return fallback


def _control_entries_from_slots(
    slots: list[str],
    widgets_values: list[Any],
    inputs: dict[str, Any],
    aligned: bool,
) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for index, slot_name in enumerate(slots):
        if slot_name != CONTROL_WIDGET_NAME or index == 0:
            continue
        if not aligned and index != len(widgets_values):
            # 整份槽位数组对不上时，只有「数组正好停在种子这一格」才能认定是旧工作流
            # 没存这个控件的值（值缺失 → randomize）；别的位置一律不插，免得错位。
            continue
        owner = slots[index - 1]
        if owner not in inputs or index - 1 >= len(widgets_values):
            # prompt 里没有这个输入（没被提交过），或者数组根本不到种子那一格
            continue
        if owner in SEED_INPUT_NAMES:
            raw = widgets_values[index - 1]
            if isinstance(raw, bool) or not isinstance(raw, int):
                # 槽位上不是种子该有的整数：八成是排布对不上，不插
                continue
        value = widgets_values[index] if index < len(widgets_values) else None
        if value not in CONTROL_WIDGET_OPTIONS:
            value = CONTROL_WIDGET_DEFAULT
        entries[owner] = {
            "name": CONTROL_WIDGET_NAME,
            "type": "COMBO",
            "options": list(CONTROL_WIDGET_OPTIONS),
            "value": value,
            "frontend": True,
        }
    return entries


def _is_link(value: Any, prompt: dict[str, Any]) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and str(value[0]) in prompt
    )


def _field_label(input_name: str, node_title: str, class_type: str, role_hint: str = "") -> str:
    if input_name in {"text", "prompt"}:
        if role_hint == "negative":
            return "反向提示词"
        if role_hint == "positive":
            return "正向提示词"
        lower_title = node_title.lower()
        if "negative" in lower_title or "反向" in node_title or "负面" in node_title:
            return "反向提示词"
        if "positive" in lower_title or "正向" in node_title:
            return "正向提示词"
    return LABELS.get(input_name, input_name.replace("_", " "))


def _field_kind(
    input_name: str,
    class_type: str,
    value: Any,
    spec: dict[str, Any],
) -> str:
    lower_class = class_type.lower()
    config = spec.get("config", {})
    options = spec.get("options", [])
    if input_name == "image" and "loadimage" in lower_class:
        return "image"
    if isinstance(value, bool):
        return "toggle"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if options:
        if len(options) <= 80 and max((len(str(item)) for item in options), default=0) <= 64:
            return "select"
        return "search"
    if bool(config.get("multiline")) or input_name in {
        "text",
        "prompt",
        "positive",
        "positive_prompt",
        "negative",
        "negative_prompt",
    }:
        return "textarea"
    if isinstance(value, str) and len(value) > 100:
        return "textarea"
    return "text"


def _prompt_role_hints(prompt: dict[str, Any]) -> dict[str, str]:
    roles: dict[str, set[str]] = {}
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        for input_name, value in inputs.items():
            if not _is_link(value, prompt):
                continue
            lower_name = str(input_name).lower()
            role = ""
            if lower_name in {"positive", "positive_prompt", "positive_cond", "conditioning_positive"}:
                role = "positive"
            elif lower_name in {"negative", "negative_prompt", "negative_cond", "conditioning_negative"}:
                role = "negative"
            if role:
                roles.setdefault(str(value[0]), set()).add(role)
    return {
        node_id: next(iter(values))
        for node_id, values in roles.items()
        if len(values) == 1
    }


# 自制节点上只给电脑端用的控件。手机端不应该把它们当成可编辑字段，
# 否则手机界面上会凭空多出「标签模式」这类开关，操作手感就变了。
NODE_HIDDEN_INPUTS: dict[str, frozenset[str]] = {
    "MobileTagCLIPTextEncode": frozenset({"标签模式", "每次随机", "tag_mode"}),
}


def _infer_fields(prompt: Any) -> list[dict[str, Any]]:
    if not isinstance(prompt, dict):
        return []
    fields: list[dict[str, Any]] = []
    role_hints = _prompt_role_hints(prompt)
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", ""))
        inputs = node.get("inputs", {})
        if not class_type or not isinstance(inputs, dict):
            continue
        meta = node.get("_meta", {})
        node_title = str(meta.get("title", class_type)) if isinstance(meta, dict) else class_type
        specs = _input_specs(class_type)

        for input_name, value in inputs.items():
            input_name = str(input_name)
            if input_name.lower() in SENSITIVE_INPUT_NAMES or input_name.startswith("_"):
                continue
            if input_name in NODE_HIDDEN_INPUTS.get(class_type, ()):
                continue
            if _is_link(value, prompt):
                continue
            if value is None or not isinstance(value, (str, int, float, bool)):
                continue

            spec = specs.get(input_name, {"required": False, "type": "", "options": [], "config": {}})
            kind = _field_kind(input_name, class_type, value, spec)
            config = spec.get("config", {})
            randomizable = input_name == "seed" or input_name.endswith("_seed")
            group = "basic" if input_name in BASIC_INPUTS or kind in {"textarea", "image"} else "advanced"
            field: dict[str, Any] = {
                "id": f"{node_id}::{input_name}",
                "node_id": str(node_id),
                "input": input_name,
                "node_type": class_type,
                "node_title": node_title,
                "label": _field_label(
                    input_name,
                    node_title,
                    class_type,
                    role_hints.get(str(node_id), ""),
                ),
                "kind": kind,
                "group": group,
                "value": value,
                "required": bool(spec.get("required")),
                "randomizable": randomizable,
            }
            options = spec.get("options", [])
            if options:
                field["options"] = options
            for key in ("min", "max", "step"):
                configured = config.get(key)
                if isinstance(configured, (int, float)):
                    field[key] = configured
            fields.append(field)

    def sort_key(field: dict[str, Any]) -> tuple[int, int, str, str]:
        group_order = 0 if field["group"] == "basic" else 1
        return (
            group_order,
            FIELD_ORDER.get(field["input"], 500),
            field["node_title"],
            field["input"],
        )

    fields.sort(key=sort_key)
    return fields


def _translated_field_label(field: dict[str, Any]) -> str:
    """参数名也是给用户看的，跟着界面一起翻。"""
    return _t(str(field.get("label") or ""))


def _coerce_value(value: Any, field: dict[str, Any]) -> Any:
    if value == "__random__" and field.get("randomizable"):
        return random.randrange(0, 2**53)

    original = field.get("value")
    if isinstance(original, bool):
        if isinstance(value, bool):
            result: Any = value
        elif str(value).lower() in {"1", "true", "yes", "on"}:
            result = True
        elif str(value).lower() in {"0", "false", "no", "off"}:
            result = False
        else:
            raise ValueError(_t("{label} 必须是开或关", label=_translated_field_label(field)))
    elif isinstance(original, int) and not isinstance(original, bool):
        result = int(value)
    elif isinstance(original, float):
        result = float(value)
    else:
        result = str(value)
        if len(result) > 200000:
            raise ValueError(_t("{label} 内容过长", label=_translated_field_label(field)))

    minimum = field.get("min")
    maximum = field.get("max")
    if isinstance(result, (int, float)):
        if isinstance(minimum, (int, float)) and result < minimum:
            raise ValueError(_t("{label} 不能小于 {minimum}", label=_translated_field_label(field), minimum=minimum))
        if isinstance(maximum, (int, float)) and result > maximum:
            raise ValueError(_t("{label} 不能大于 {maximum}", label=_translated_field_label(field), maximum=maximum))

    options = field.get("options", [])
    if options and result not in options:
        comparable = {str(item): item for item in options}
        if str(result) in comparable:
            result = comparable[str(result)]
        else:
            raise ValueError(_t("{label} 的选项无效", label=_translated_field_label(field)))
    return result


# 「节点id::输入名」的提交键：节点号只允许 ComfyUI 真会用到的字符（数字/UUID/下划线），
# 输入名不许带冒号。长度也封顶——高级页能显示的输入比 fields 多，键是手机上直接传上来的。
SUBMIT_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.\-]{1,64}::[^:]{1,128}$")
SUBMIT_KEY_MAX_LENGTH = 200
SUBMIT_TEXT_MAX_LENGTH = 200000   # 和 _coerce_value 的字符串上限保持一致


def _split_submit_key(key: str) -> tuple[str, str] | None:
    """把提交键拆成 (节点id, 输入名)；形状不合法（太长、字符集不对、缺一半）返回 None。"""
    if not key or len(key) > SUBMIT_KEY_MAX_LENGTH:
        return None
    if SUBMIT_KEY_PATTERN.fullmatch(key) is None:
        return None
    node_id, _, input_name = key.rpartition("::")
    if not node_id or not input_name:
        return None
    return node_id, input_name


def _as_number(value: Any) -> int | float | None:
    """手机端传回来的一律是字符串，这里宽松地当数字看；不是数字返回 None。"""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text, 10)
        except ValueError:
            pass
        try:
            number = float(text)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _as_bool(value: Any) -> bool | None:
    """和 _coerce_value 认同一套写法（1/true/yes/on、0/false/no/off）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _pick_option(value: Any, options: list[Any]) -> tuple[bool, Any]:
    """COMBO 只能在候选里挑：先按原值比，再按字符串比（手机端传回来的是字符串）。"""
    if value is None or isinstance(value, (list, tuple, dict, set)):
        return False, None
    if not options:
        # 候选是动态填的（例如没扫描到任何模型），此时不拦，交给 ComfyUI 自己校验。
        return True, str(value)
    if value in options:
        return True, value
    by_text = {str(item): item for item in options}
    if str(value) in by_text:
        return True, by_text[str(value)]
    return False, None


def _convert_submitted_value(value: Any, descriptor: dict[str, Any]) -> tuple[bool, Any]:
    """按 schema 转换值，返回 (是否可用, 转换后的值)。

    数字越界就夹到 min/max；转不动（类型对不上、选项不在候选里、文本超长）返回 False，
    由调用方跳过这一条，而不是把整个提交打回去。
    """
    type_name = str(descriptor.get("type") or "STRING")
    if type_name == "BOOLEAN":
        parsed = _as_bool(value)
        if parsed is None:
            return False, None
        return True, parsed
    if type_name in {"INT", "FLOAT"}:
        number = _as_number(value)
        if number is None:
            return False, None
        minimum = descriptor.get("min")
        maximum = descriptor.get("max")
        if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) and number < minimum:
            number = minimum
        if isinstance(maximum, (int, float)) and not isinstance(maximum, bool) and number > maximum:
            number = maximum
        return True, int(number) if type_name == "INT" else float(number)
    if type_name == "COMBO":
        return _pick_option(value, descriptor.get("options") or [])
    # STRING 和其它一切类型都按文本收：真正的合法性由 ComfyUI 自己的 prompt 校验兜底。
    if value is None or isinstance(value, (list, tuple, dict, set)):
        return False, None
    text = str(value)
    if len(text) > SUBMIT_TEXT_MAX_LENGTH:
        return False, None
    return True, text


def _apply_submitted_input(prompt: dict[str, Any], key: str, value: Any) -> tuple[bool, Any]:
    """把「节点id::输入名」按 schema 写回 prompt，返回 (是否写入, 写入的值)。

    安全底线：键形状必须合法、节点必须已经存在、输入名必须是该节点 inputs 里已有的键，
    一条不满足就跳过——绝不允许凭提交内容造出新节点或新输入（也不用 getattr 之类的动态取用）。
    已经被连线接管的输入同样跳过：画布上它是插槽不是控件，写值等于把线剪断。
    graph 里 frontend=true 的控件（例如 control_after_generate）在 API prompt 里本来就不存在，
    走到这里自然会因为「输入名不存在」被安静跳过，不报错。
    """
    if not isinstance(prompt, dict):
        return False, None
    parsed = _split_submit_key(str(key))
    if parsed is None:
        return False, None
    node_id, input_name = parsed
    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return False, None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict) or input_name not in inputs:
        return False, None
    current = inputs[input_name]
    if _is_link(current, prompt):
        return False, None
    spec = _input_specs(str(node.get("class_type") or "")).get(input_name)
    applied, converted = _convert_submitted_value(value, _input_descriptor(spec, current))
    if not applied:
        return False, None
    inputs[input_name] = converted
    return True, converted


# ---- 手机 → 电脑端指令通道 ----------------------------------------------
# 手机端拿到的是电脑端同步过来的**快照**（API prompt + 原生 workflow）：在「高级」页改一个
# 值只改得动手机本地的 state.values，电脑画布上的节点毫无变化——自制节点的面板由电脑端
# 自己的代码画（例如「标签模式」开关要 node 自己的 widget.callback 去 setVisible），
# 所以现象就是「点了没反应」。这类改动必须写成一条指令排进待办，由电脑端 web/sync.js 在
# 它自己的画布上照做，再把它自己的新状态同步回手机。
DESKTOP_COMMANDS_PATH = PLUGIN_ROOT / ".runtime" / "desktop_commands.json"
DESKTOP_COMMANDS_MAX = 50        # 只留最近这么多条：电脑端一直不开也不会无限堆积
DESKTOP_COMMAND_ACK_MAX = 200    # 一次 ack 最多删这么多条
DESKTOP_COMMAND_KEY_MAX_LENGTH = 200
DESKTOP_COMMAND_ID_MAX_LENGTH = 64
DESKTOP_COMMAND_VALUE_MAX_LENGTH = SUBMIT_TEXT_MAX_LENGTH   # 字符串 200000，和提交路径同一条线
DESKTOP_COMMAND_FIELDS = frozenset({"workflow_id", "node_id", "input", "value"})
# 指令的身份是「节点id::输入名」，形状沿用提交路径那套约束（节点号只允许 ComfyUI 真会
# 出现的字符、输入名不许带冒号、两段各自封顶），只多容忍一个单冒号写法。
DESKTOP_COMMAND_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.\-]{1,64}::?[^:]{1,128}$")

_DESKTOP_COMMANDS_LOCK = threading.RLock()
_DESKTOP_COMMANDS: list[dict[str, Any]] | None = None   # None = 还没从磁盘读过


def _desktop_command_key(node_id: Any, input_name: Any) -> str | None:
    """把 (节点id, 输入名) 拼成去重用的键；形状不合法（空、太长、字符不对）返回 None。"""
    node_id = "" if node_id is None else str(node_id)
    input_name = "" if input_name is None else str(input_name)
    if not node_id or not input_name:
        return None
    if len(node_id) > 64 or len(input_name) > 128:
        return None
    if re.search(r"[\x00-\x1f]", node_id) or re.search(r"[\x00-\x1f]", input_name):
        return None
    key = f"{node_id}::{input_name}"
    if len(key) > DESKTOP_COMMAND_KEY_MAX_LENGTH:
        return None
    if DESKTOP_COMMAND_KEY_PATTERN.fullmatch(key) is None:
        return None
    return key


def _desktop_command_value(value: Any) -> tuple[bool, Any]:
    """指令的值只收标量（布尔/整数/浮点/字符串/空）；字符串封顶，数组和对象一律拒。

    这些都是控件的真实值形态：开关是布尔、数字框是数字、文本框是字符串。放数组和对象进来
    等于让手机端凭一条指令往画布控件里塞任意结构，没必要也不安全。
    """
    if value is None or isinstance(value, (bool, int)):
        return True, value
    if isinstance(value, float):
        return (True, value) if math.isfinite(value) else (False, None)
    if isinstance(value, str):
        return (True, value) if len(value) <= DESKTOP_COMMAND_VALUE_MAX_LENGTH else (False, None)
    return False, None


def _desktop_command_from_payload(record: Any, payload: Any) -> tuple[dict[str, Any] | None, str, str]:
    """校验一条手机端指令，返回 (指令内容, 错误文案, 原因)。

    安全底线和提交路径一致：只认列出的四个字段，节点必须真实存在于该工作流的 prompt 里，
    输入名必须是这个节点 inputs 里已有的键——绝不允许凭指令内容造出新节点或新输入。
    原因（payload/node/input/value）是给手机端调试看的机器可读标记，提示语本身走词典。
    """
    if not isinstance(payload, dict):
        return None, "参数格式错误", "payload"
    if set(payload) - DESKTOP_COMMAND_FIELDS:
        return None, "参数格式错误", "payload"
    node_id = payload.get("node_id")
    if isinstance(node_id, bool) or not isinstance(node_id, (str, int)):
        return None, "参数格式错误", "payload"
    input_name = payload.get("input")
    if not isinstance(input_name, str):
        return None, "参数格式错误", "payload"
    if _desktop_command_key(node_id, input_name) is None:
        return None, "参数格式错误", "payload"
    if "value" not in payload:
        return None, "参数格式错误", "payload"
    valid, value = _desktop_command_value(payload.get("value"))
    if not valid:
        return None, "参数格式错误", "value"
    prompt = record.get("prompt") if isinstance(record, dict) else None
    if not isinstance(prompt, dict):
        return None, "工作流不存在", "workflow"
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return None, "没有匹配的节点", "node"
    inputs = node.get("inputs")
    if not isinstance(inputs, dict) or input_name not in inputs:
        return None, "此类型暂不支持编辑", "input"
    # 被连线接管的输入在画布上是插槽不是控件，写值等于把线剪断——和提交路径同一条底线。
    if _is_link(inputs[input_name], prompt):
        return None, "此类型暂不支持编辑", "input"
    return {"node_id": str(node_id), "input": input_name, "value": value}, "", ""


def _desktop_command_stored_ok(item: Any) -> bool:
    """磁盘上的旧条目也要过一遍形状校验：坏数据宁可丢掉，也不能喂给电脑端去改画布。"""
    if not isinstance(item, dict):
        return False
    if not isinstance(item.get("workflow_id"), str) or not item["workflow_id"]:
        return False
    command_id = item.get("id")
    if not isinstance(command_id, str) or not command_id or len(command_id) > DESKTOP_COMMAND_ID_MAX_LENGTH:
        return False
    if _desktop_command_key(item.get("node_id"), item.get("input")) is None:
        return False
    return _desktop_command_value(item.get("value"))[0]


def _desktop_commands_read_disk() -> list[dict[str, Any]]:
    """从 .runtime/desktop_commands.json 读队列；文件没有/坏了都当空队列。调用方持锁。"""
    try:
        data = _read_json(DESKTOP_COMMANDS_PATH)
    except (OSError, ValueError):
        return []
    items = data.get("commands")
    if not isinstance(items, list):
        return []
    return [dict(item) for item in items if _desktop_command_stored_ok(item)][-DESKTOP_COMMANDS_MAX:]


def _desktop_commands_unlocked() -> list[dict[str, Any]]:
    """取内存里的队列；第一次访问时从磁盘读回来（服务重启后待办不丢）。调用方持锁。"""
    global _DESKTOP_COMMANDS
    if _DESKTOP_COMMANDS is None:
        _DESKTOP_COMMANDS = _desktop_commands_read_disk()
    return _DESKTOP_COMMANDS


def _desktop_commands_persist(commands: list[dict[str, Any]]) -> None:
    """落盘。写失败只记日志：队列本体在内存里，电脑端照样领得到，不能因此把接口打回去。"""
    try:
        _write_json_atomic(DESKTOP_COMMANDS_PATH, {"schema": 1, "commands": commands})
    except OSError:
        LOG.warning("[Mobile Remote] desktop command queue not persisted", exc_info=True)


def _desktop_commands_count() -> int:
    with _DESKTOP_COMMANDS_LOCK:
        return len(_desktop_commands_unlocked())


def _desktop_commands_pending(workflow_id: str) -> list[dict[str, Any]]:
    """某个工作流还没被电脑端执行的指令。领了**不删**：等电脑端 ack 说它真落到画布上了。"""
    with _DESKTOP_COMMANDS_LOCK:
        return [
            {"id": item["id"], "node_id": item["node_id"], "input": item["input"], "value": item["value"]}
            for item in _desktop_commands_unlocked()
            if item.get("workflow_id") == workflow_id
        ]


def _desktop_command_enqueue(command: dict[str, Any]) -> int:
    """追加一条待办；同 工作流+节点+输入 只留最新一条，总数封顶。返回队列长度。

    「只留最新」是必须的：手机上把开关拨来拨去会产生一串互相矛盾的旧值，
    电脑端照单全收的话最终状态取决于到达顺序——只留最后一条才是用户的真实意图。
    """
    global _DESKTOP_COMMANDS
    key = (command["workflow_id"], _desktop_command_key(command["node_id"], command["input"]))
    with _DESKTOP_COMMANDS_LOCK:
        commands = [
            item for item in _desktop_commands_unlocked()
            if (item.get("workflow_id"), _desktop_command_key(item.get("node_id"), item.get("input"))) != key
        ]
        commands.append(dict(command))
        del commands[:-DESKTOP_COMMANDS_MAX]
        _DESKTOP_COMMANDS = commands
        _desktop_commands_persist(commands)
        return len(commands)


def _desktop_commands_ack(ids: list[str]) -> int:
    """删掉电脑端确认执行过的指令，返回删掉的条数。"""
    global _DESKTOP_COMMANDS
    wanted = {str(item) for item in ids}
    if not wanted:
        return 0
    with _DESKTOP_COMMANDS_LOCK:
        commands = _desktop_commands_unlocked()
        kept = [item for item in commands if item.get("id") not in wanted]
        removed = len(commands) - len(kept)
        if removed:
            _DESKTOP_COMMANDS = kept
            _desktop_commands_persist(kept)
        return removed


def _desktop_command_submit(payload: Any) -> tuple[dict[str, Any] | None, str, int, str]:
    """手机端提交一条指令：校验 → 入队。返回 (指令, 错误文案, HTTP 状态, 原因)。"""
    if not isinstance(payload, dict):
        return None, "参数格式错误", 400, "payload"
    workflow_id = str(payload.get("workflow_id", ""))
    try:
        record = _load_record(workflow_id)
    except ValueError:
        return None, "工作流编号无效", 400, "workflow"
    except FileNotFoundError:
        return None, "工作流不存在", 404, "workflow"
    command, error, reason = _desktop_command_from_payload(record, payload)
    if command is None:
        return None, error, 400, reason
    command.update({"id": uuid.uuid4().hex, "workflow_id": workflow_id, "at": int(time.time() * 1000)})
    _desktop_command_enqueue(command)
    return command, "", 200, ""


def _desktop_commands_pending_payload(workflow_id: Any) -> tuple[dict[str, Any] | None, str]:
    """电脑端领取待办的响应体。

    工作流编号只校验形状，不要求记录还在：记录被删掉时不该让整轮轮询变成 404 噪音。
    """
    workflow_id = str(workflow_id or "")
    try:
        _record_path(workflow_id)
    except ValueError:
        return None, "工作流编号无效"
    return {"ok": True, "commands": _desktop_commands_pending(workflow_id)}, ""


def _desktop_commands_ack_payload(payload: Any) -> tuple[dict[str, Any] | None, str]:
    """电脑端确认执行的响应体：删指令、回报剩余条数。"""
    if not isinstance(payload, dict) or set(payload) - {"ids"}:
        return None, "参数格式错误"
    raw = payload.get("ids")
    if not isinstance(raw, list) or len(raw) > DESKTOP_COMMAND_ACK_MAX:
        return None, "参数格式错误"
    ids: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item or len(item) > DESKTOP_COMMAND_ID_MAX_LENGTH:
            return None, "参数格式错误"
        ids.append(item)
    return {"ok": True, "removed": _desktop_commands_ack(ids), "pending": _desktop_commands_count()}, ""


async def _enqueue_prompt(
    prompt: dict[str, Any],
    client_id: str,
    workflow: dict[str, Any],
    workflow_id: str,
    workflow_name: str,
    submitted_values: dict[str, Any] | None = None,
    preset: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, Any]:
    import execution
    from server import PromptServer

    prompt_server = PromptServer.instance
    prompt_id = str(uuid.uuid4())
    request_data: dict[str, Any] = {
        "prompt": prompt,
        "prompt_id": prompt_id,
        "client_id": client_id,
    }
    request_data = prompt_server.trigger_on_prompt(request_data)
    prompt = request_data.get("prompt")
    if not isinstance(prompt, dict):
        return None, {"type": "no_prompt", "message": _t("工作流数据无效")}

    number = prompt_server.number
    prompt_server.number += 1
    prompt_server.node_replace_manager.apply_replacements(prompt)
    valid = await execution.validate_prompt(prompt_id, prompt, None)
    if not valid[0]:
        return None, {"error": valid[1], "node_errors": valid[3]}

    workflow_copy = copy.deepcopy(workflow) if isinstance(workflow, dict) else {}
    workflow_copy["id"] = workflow_id
    extra_data: dict[str, Any] = {
        "client_id": client_id,
        "create_time": int(time.time() * 1000),
        "extra_pnginfo": {"workflow": workflow_copy},
        "mobile_remote": {
            "workflow_id": workflow_id,
            "workflow_name": workflow_name,
            "values": submitted_values or {},
            "preset": preset or {},
        },
    }
    sensitive: dict[str, Any] = {}
    for sensitive_key in execution.SENSITIVE_EXTRA_DATA_KEYS:
        if sensitive_key in extra_data:
            sensitive[sensitive_key] = extra_data.pop(sensitive_key)
    prompt_server.prompt_queue.put((number, prompt_id, prompt, extra_data, valid[2], sensitive))
    return {
        "ok": True,
        "prompt_id": prompt_id,
        "number": number,
        "node_errors": valid[3],
        "workflow_id": workflow_id,
        "workflow_name": workflow_name,
    }, None


def _queue_snapshot() -> tuple[list, list, dict]:
    from server import PromptServer

    queue = PromptServer.instance.prompt_queue
    running, pending = queue.get_current_queue_volatile()
    history = queue.get_history()
    return [item[:5] for item in running], [item[:5] for item in pending], history


def _unsafe_path_part(value: str) -> bool:
    text = str(value or "")
    if not text:
        return False
    return (
        ".." in text
        or text.startswith(("/", "\\"))
        or ":" in text
        or "\x00" in text
    )


def _resolve_media_path(filename: str, subfolder: str = "", type_name: str = "output") -> Path | None:
    import folder_paths

    name = str(filename or "")
    folder = str(subfolder or "")
    kind = str(type_name or "output") or "output"
    if not name or _unsafe_path_part(name) or "/" in name or "\\" in name:
        return None
    if _unsafe_path_part(folder):
        return None
    if kind not in {"output", "temp"}:
        return None
    base = folder_paths.get_directory_by_type(kind)
    if not base:
        return None
    base_abs = os.path.abspath(base)
    full = os.path.abspath(os.path.join(base_abs, folder, name) if folder else os.path.join(base_abs, name))
    try:
        if os.path.commonpath([full, base_abs]) != base_abs:
            return None
    except ValueError:
        return None
    return Path(full)


def _media_file_exists(filename: str, subfolder: str = "", type_name: str = "output") -> bool:
    path = _resolve_media_path(filename, subfolder, type_name)
    return bool(path and path.is_file())


def _media_item_exists(item: dict[str, Any] | None) -> bool:
    if not isinstance(item, dict) or not item.get("filename"):
        return False
    return _media_file_exists(
        str(item.get("filename", "")),
        str(item.get("subfolder", "") or ""),
        str(item.get("type", "output") or "output"),
    )


def _history_completion_time(entry: dict[str, Any]) -> int:
    """Server-side ms timestamp of the last status message (job end)."""
    try:
        messages = (entry.get("status") or {}).get("messages") or []
    except AttributeError:
        return 0
    latest = 0
    for message in messages:
        if isinstance(message, (list, tuple)) and len(message) > 1 and isinstance(message[1], dict):
            try:
                latest = max(latest, int(message[1].get("timestamp", 0) or 0))
            except (TypeError, ValueError):
                continue
    return latest


# SaveImage derives its filename counter from the files left on disk, so
# deleting images makes new generations reuse old filenames. A history entry
# is only allowed to show a file whose modification time predates the job's
# completion — otherwise the file is a newer image that merely reused the
# name and must never resurrect the older entry.
_MEDIA_FRESHNESS_SLACK_MS = 30_000


def _media_item_fresh(item: dict[str, Any] | None, done_ms: int = 0) -> bool:
    if not isinstance(item, dict) or not item.get("filename"):
        return False
    path = _resolve_media_path(
        str(item.get("filename", "")),
        str(item.get("subfolder", "") or ""),
        str(item.get("type", "output") or "output"),
    )
    if path is None or not path.is_file():
        return False
    if done_ms <= 0:
        return True
    try:
        mtime_ms = int(path.stat().st_mtime * 1000)
    except OSError:
        return False
    return mtime_ms <= done_ms + _MEDIA_FRESHNESS_SLACK_MS


def _favorite_key(job_id: str, filename: str, subfolder: str, type_name: str) -> tuple[str, str, str, str]:
    return (
        str(job_id or ""),
        str(filename or ""),
        str(subfolder or ""),
        str(type_name or "output") or "output",
    )


def _load_favorites() -> set[tuple[str, str, str, str]]:
    global _FAVORITES_LOADED
    with _FAVORITES_LOCK:
        if _FAVORITES_LOADED:
            return _FAVORITES
        try:
            data = _read_json(FAVORITES_PATH)
            for item in data.get("favorites", []) or []:
                if isinstance(item, dict) and item.get("filename"):
                    _FAVORITES.add(
                        _favorite_key(
                            item.get("job_id", ""),
                            item.get("filename", ""),
                            item.get("subfolder", ""),
                            item.get("type", "output"),
                        )
                    )
        except (OSError, ValueError):
            LOG.debug("[Mobile Remote] no readable favorites file yet")
        _FAVORITES_LOADED = True
        return _FAVORITES


def _persist_favorites() -> None:
    with _FAVORITES_LOCK:
        payload = {
            "schema": 1,
            "saved_at": int(time.time() * 1000),
            "favorites": [
                {"job_id": job_id, "filename": filename, "subfolder": subfolder, "type": type_name}
                for job_id, filename, subfolder, type_name in sorted(_FAVORITES)
            ],
        }
        try:
            _write_json_atomic(FAVORITES_PATH, payload)
        except OSError:
            LOG.exception("[Mobile Remote] failed to persist favorites")


def _is_favorite(job_id: str, filename: str, subfolder: str, type_name: str) -> bool:
    _load_favorites()
    key = _favorite_key(job_id, filename, subfolder, type_name)
    with _FAVORITES_LOCK:
        if key in _FAVORITES:
            return True
    path = _favorite_file_path(job_id, filename)
    return path is not None and path.is_file()


def _favorite_disk_job_ids() -> set[str]:
    if not FAVORITE_FILES.is_dir():
        return set()
    found: set[str] = set()
    try:
        for job_dir in FAVORITE_FILES.iterdir():
            if not job_dir.is_dir() or _unsafe_path_part(job_dir.name):
                continue
            try:
                if any(path.is_file() for path in job_dir.iterdir()):
                    found.add(job_dir.name)
            except OSError:
                continue
    except OSError:
        return set()
    return found


def _favorite_disk_files(job_id: str) -> list[str]:
    folder = FAVORITE_FILES / str(job_id or "")
    if not folder.is_dir() or _unsafe_path_part(str(job_id or "")):
        return []
    names: list[str] = []
    try:
        for path in folder.iterdir():
            if not path.is_file() or _unsafe_path_part(path.name) or "/" in path.name or "\\" in path.name:
                continue
            suffix = path.suffix.lower()
            if path.name == FAVORITE_META_NAME or suffix in {".json", ".tmp"} or path.name.startswith(f"{FAVORITE_META_NAME}."):
                if suffix == ".tmp" or path.name.startswith(f"{FAVORITE_META_NAME}."):
                    try:
                        path.unlink()
                    except OSError:
                        pass
                continue
            if suffix not in FAVORITE_IMAGE_SUFFIXES:
                continue
            names.append(path.name)
    except OSError:
        return []
    return names


def _favorite_job_ids() -> set[str]:
    _load_favorites()
    with _FAVORITES_LOCK:
        ids = {job_id for job_id, _filename, _sub, _type in _FAVORITES if job_id}
    return ids | _favorite_disk_job_ids()


def _favorites_for_job(job_id: str) -> list[tuple[str, str, str, str]]:
    job_id = str(job_id or "")
    if not job_id:
        return []
    _load_favorites()
    with _FAVORITES_LOCK:
        return [key for key in _FAVORITES if key[0] == job_id]


def _favorite_file_path(job_id: str, filename: str) -> Path | None:
    if not job_id or not filename or _unsafe_path_part(job_id) or _unsafe_path_part(filename):
        return None
    if "/" in filename or "\\" in filename or "/" in job_id or "\\" in job_id:
        return None
    return FAVORITE_FILES / job_id / filename


def _preview_webp_bytes(path: Path, size: int = 384) -> bytes | None:
    try:
        from io import BytesIO
        from PIL import Image

        from PIL import ImageFile
        with _PREVIEW_LOCK:
            previous_truncated = ImageFile.LOAD_TRUNCATED_IMAGES
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            try:
                with Image.open(path) as img:
                    img.load()
                    img.thumbnail((size, size))
                    if img.mode not in {"RGB", "L"}:
                        img = img.convert("RGB")
                    buffer = BytesIO()
                    img.save(buffer, format="WEBP", quality=72, method=4)
                    return buffer.getvalue()
            finally:
                ImageFile.LOAD_TRUNCATED_IMAGES = previous_truncated
    except Exception:
        LOG.debug("[Mobile Remote] could not build preview for %s", path)
        return None


def _favorite_meta_path(job_id: str) -> Path | None:
    folder = _favorite_file_path(job_id, FAVORITE_META_NAME)
    return folder


def _read_favorite_meta(job_id: str) -> dict[str, Any] | None:
    path = _favorite_meta_path(job_id)
    if path is None or not path.is_file():
        return None
    try:
        data = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _history_entry_for_favorite(job_id: str) -> dict[str, Any] | None:
    _load_history_index()
    with _HISTORY_LOCK:
        entry = _HISTORY_CACHE.get(str(job_id))
        if isinstance(entry, dict):
            return entry
    try:
        from server import PromptServer

        live = PromptServer.instance.prompt_queue.get_history(prompt_id=job_id).get(job_id)
    except Exception:
        live = None
    return live if isinstance(live, dict) else None


def _write_favorite_meta(job_id: str) -> None:
    path = _favorite_meta_path(job_id)
    if path is None:
        return
    folder = path.parent
    if not folder.is_dir():
        return
    existing = _read_favorite_meta(job_id) or {}
    entry = _history_entry_for_favorite(job_id)
    payload: dict[str, Any] = {
        "schema": 1,
        "job_id": str(job_id),
        "saved_at": int(time.time() * 1000),
        "create_time": existing.get("create_time") or 0,
        "workflow_id": existing.get("workflow_id") or "",
        "workflow_name": existing.get("workflow_name") or "",
        "model_name": existing.get("model_name") or "",
        "positive_prompt": existing.get("positive_prompt") or "",
        "seed": existing.get("seed") or "",
        "preset": existing.get("preset") if isinstance(existing.get("preset"), dict) else None,
        "prompt": existing.get("prompt"),
        "status": existing.get("status") if isinstance(existing.get("status"), dict) else {},
    }
    if isinstance(entry, dict):
        fake = {"prompt": entry.get("prompt"), "status": entry.get("status")}
        payload["prompt"] = _compact_json(entry.get("prompt"), 32000)
        payload["status"] = _compact_json(entry.get("status") or {}, 4000)
        payload["create_time"] = _history_entry_time(entry) or payload["create_time"]
        payload["positive_prompt"] = _entry_positive_prompt(fake) or payload["positive_prompt"]
        payload["seed"] = _entry_seed(fake) or payload["seed"]
        preset = _entry_preset(fake)
        if preset:
            payload["preset"] = _compact_json(preset, 32000)
        model_name = _history_model_name(entry)
        if model_name:
            payload["model_name"] = model_name
        extra = _entry_extra(entry)
        remote = extra.get("mobile_remote") if isinstance(extra.get("mobile_remote"), dict) else {}
        if remote.get("workflow_name"):
            payload["workflow_name"] = str(remote.get("workflow_name") or "")
        if remote.get("workflow_id"):
            payload["workflow_id"] = str(remote.get("workflow_id") or "")
        workflow_info = extra.get("extra_pnginfo", {})
        if isinstance(workflow_info, dict) and isinstance(workflow_info.get("workflow"), dict):
            workflow_id = str(workflow_info["workflow"].get("id", "") or "")
            if workflow_id:
                payload["workflow_id"] = workflow_id
    if not payload["create_time"]:
        latest = 0
        for name in _favorite_disk_files(job_id):
            image = _favorite_file_path(job_id, name)
            if image is not None and image.is_file():
                latest = max(latest, int(image.stat().st_mtime * 1000))
        payload["create_time"] = latest
    if not payload["workflow_name"]:
        payload["workflow_name"] = "收藏"
    # 内容没变就别写盘：这个函数会被后台维护反复调用，每次都写等于白刷磁盘。
    if {k: v for k, v in existing.items() if k != "saved_at"} == {
        k: v for k, v in payload.items() if k != "saved_at"
    }:
        return
    try:
        _write_json_atomic(path, payload)
    except OSError:
        LOG.debug("[Mobile Remote] could not write favorite workflow backup")


def _apply_favorite_meta(job: dict[str, Any], job_id: str) -> dict[str, Any]:
    meta = _read_favorite_meta(job_id)
    if not isinstance(meta, dict):
        return job
    for field in ("positive_prompt", "seed", "workflow_name", "model_name", "workflow_id"):
        if not job.get(field) and meta.get(field):
            job[field] = meta[field]
    if not job.get("preset") and isinstance(meta.get("preset"), dict):
        job["preset"] = meta["preset"]
    if not job.get("create_time") and meta.get("create_time"):
        job["create_time"] = meta["create_time"]
    return job


def _history_item_from_favorite_meta(job_id: str) -> dict[str, Any]:
    meta = _read_favorite_meta(job_id) or {}
    prompt = meta.get("prompt")
    if not isinstance(prompt, (list, tuple)):
        extra = {
            "create_time": meta.get("create_time") or 0,
            "mobile_remote": {
                "workflow_id": meta.get("workflow_id") or "",
                "workflow_name": meta.get("workflow_name") or "",
                "preset": meta.get("preset") if isinstance(meta.get("preset"), dict) else None,
            },
        }
        prompt = [0, job_id, {}, extra]
    return {"prompt": prompt, "status": meta.get("status") if isinstance(meta.get("status"), dict) else {}, "outputs": {}}


def _backfill_favorite_meta() -> None:
    """给收藏补 job.json。纯粹是兜底：新增收藏时 _ensure_favorite_copy 已经即时写过，
    而这里每轮要给 166 个收藏各读一份元数据、再建一份 30KB 载荷比对，约 1.5 秒。
    所以限频，不必每 15 秒来一次。"""
    global _FAVORITE_META_BACKFILL_AT
    now = time.monotonic()
    if now - _FAVORITE_META_BACKFILL_AT < FAVORITE_META_BACKFILL_INTERVAL:
        return
    _FAVORITE_META_BACKFILL_AT = now
    for job_id in _favorite_disk_job_ids():
        path = _favorite_meta_path(job_id)
        if path is None:
            continue
        if path.is_file() and not _history_entry_for_favorite(job_id):
            continue
        _write_favorite_meta(job_id)


def _ensure_favorite_copy(job_id: str, filename: str, subfolder: str, type_name: str) -> Path | None:
    dest = _favorite_file_path(job_id, filename)
    if dest is None:
        return None
    copied = False
    if not dest.is_file():
        source = _resolve_media_path(filename, subfolder, type_name)
        if source is None or not source.is_file():
            return None
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
            copied = True
        except OSError:
            LOG.exception("[Mobile Remote] failed to copy favorite file")
            return None
    if dest.is_file():
        if copied:
            _write_favorite_meta(job_id)
        return dest
    return None


def _delete_favorite_copy(job_id: str, filename: str) -> None:
    path = _favorite_file_path(job_id, filename)
    if path is None or not path.is_file():
        return
    try:
        path.unlink()
        parent = path.parent
        if parent.is_dir():
            leftover = [item for item in parent.iterdir() if item.name != FAVORITE_META_NAME]
            if not leftover:
                meta = parent / FAVORITE_META_NAME
                meta.unlink(missing_ok=True)
                parent.rmdir()
    except OSError:
        LOG.debug("[Mobile Remote] could not remove favorite copy")


def _toggle_favorite(job_id: str, filename: str, subfolder: str, type_name: str) -> bool:
    _load_favorites()
    key = _favorite_key(job_id, filename, subfolder, type_name)
    with _FAVORITES_LOCK:
        # Reconcile an old/orphaned on-disk favorite before flipping the exact key.
        if key not in _FAVORITES:
            path = _favorite_file_path(job_id, filename)
            if path is not None and path.is_file():
                _FAVORITES.add(key)
        if key in _FAVORITES:
            _FAVORITES.discard(key)
            added = False
        else:
            _FAVORITES.add(key)
            added = True
    _persist_favorites()
    _bump_gallery_revision()
    if added:
        _ensure_favorite_copy(job_id, filename, subfolder, type_name)
        _persist_history_index()
    else:
        _delete_favorite_copy(job_id, filename)
    return added


def _toggle_favorite_result(job_id: str, filename: str, subfolder: str, type_name: str) -> dict[str, Any]:
    # 校验和切换必须是一个事务：多个浏览器/手机请求同时点击时不能把同一次点击翻转两次。
    with _FAVORITE_TOGGLE_LOCK:
        already_favorite = _is_favorite(job_id, filename, subfolder, type_name)
        if not already_favorite and not _media_belongs_to_job_without_favorites(job_id, filename, subfolder, type_name):
            return {"ok": False, "error": "无法收藏这张图"}
        return {"ok": True, "favorite": _toggle_favorite(job_id, filename, subfolder, type_name)}


def _delete_output_result(job_id: str, filename: str, subfolder: str, type_name: str) -> dict[str, Any]:
    path = _resolve_media_path(filename, subfolder, type_name)
    if path is None or not _media_belongs_to_job_without_favorites(job_id, filename, subfolder, type_name):
        return {"ok": False, "error": "无法删除这张图", "status": 400}
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        LOG.exception("[Mobile Remote] failed to delete output file")
        return {"ok": False, "error": "删除失败", "status": 500}
    _load_history_index()
    _strip_output_from_history(filename, subfolder, type_name, job_id)
    with _FAVORITE_TOGGLE_LOCK:
        _forget_favorites_for_file(filename, subfolder, type_name, job_id)
    _bump_gallery_revision()
    return {"ok": True}


def _job_detail_result(job_id: str) -> dict[str, Any]:
    from comfy_execution.jobs import get_job

    running, pending, history = _queue_snapshot()
    job = get_job(job_id, running, pending, history)
    if job is not None:
        history_item = history.get(job_id)
        return {"ok": True, "job": _sanitize_job_detail(_decorate_job(job, history_item))}
    _sync_history_from_live(maintenance=False)
    entry = _load_history_index().get(job_id)
    if entry is not None:
        return {"ok": True, "job": _sanitize_job_detail(_decorate_job(_persisted_job(job_id, entry), entry))}
    extra = _favorite_only_job(job_id)
    if extra is not None:
        return {"ok": True, "job": _sanitize_job_detail(extra)}
    return {"ok": False, "error": "任务不存在", "status": 404}


def _forget_favorites_for_file(filename: str, subfolder: str, type_name: str, job_id: str = "") -> None:
    """Drop only the exact job/file favorite; never cross-delete reused filenames."""
    _load_favorites()
    target = _favorite_key(job_id, filename, subfolder, type_name) if job_id else None
    dropped_keys: list[tuple[str, str, str, str]] = []
    with _FAVORITES_LOCK:
        for key in list(_FAVORITES):
            if target is not None:
                matches = key == target
            else:
                matches = key[1] == str(filename or "") and key[2] == str(subfolder or "") and key[3] == str(type_name or "output")
            if matches:
                _FAVORITES.discard(key)
                dropped_keys.append(key)
    if dropped_keys:
        _persist_favorites()
        _bump_gallery_revision()
        for favorite_job_id, name, _folder, _kind in dropped_keys:
            _delete_favorite_copy(favorite_job_id, name)


def _strip_images_from_outputs(outputs: Any, filename: str, subfolder: str, type_name: str) -> bool:
    if not isinstance(outputs, dict):
        return False
    changed = False
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        images = node_output.get("images")
        if not isinstance(images, list):
            continue
        kept = [
            image
            for image in images
            if not (
                isinstance(image, dict)
                and str(image.get("filename", "")) == filename
                and str(image.get("subfolder", "") or "") == subfolder
                and str(image.get("type", "output") or "output") == type_name
            )
        ]
        if len(kept) != len(images):
            node_output["images"] = kept
            changed = True
    return changed


def _forget_output_in_live_history(job_id: str, filename: str, subfolder: str, type_name: str) -> None:
    if not job_id:
        return
    try:
        from server import PromptServer

        queue = PromptServer.instance.prompt_queue
    except Exception:
        return
    with queue.mutex:
        entry = queue.history.get(job_id)
        if isinstance(entry, dict):
            _strip_images_from_outputs(entry.get("outputs"), filename, subfolder, type_name)


def _strip_output_from_history(filename: str, subfolder: str, type_name: str, job_id: str) -> None:
    if not job_id:
        return
    _forget_output_in_live_history(job_id, filename, subfolder, type_name)
    changed = False
    with _HISTORY_LOCK:
        entry = _HISTORY_CACHE.get(job_id)
        if isinstance(entry, dict):
            replacement = copy.deepcopy(entry)
            if _strip_images_from_outputs(replacement.get("outputs"), filename, subfolder, type_name):
                _HISTORY_CACHE[job_id] = replacement
                changed = True
    if changed:
        _persist_history_index()


def _history_gallery(history_item: dict[str, Any] | None, job_id: str = "") -> list[dict[str, str]]:
    if not isinstance(history_item, dict):
        return []
    marker = str(job_id or "")
    if marker:
        cached = _GALLERY_CACHE.get(marker)
        if (
            cached is not None
            and cached[0] is history_item
            and cached[1] == _GALLERY_REVISION
        ):
            # 返回副本：调用方会往条目里塞字段，别把缓存本身改脏
            return [dict(item) for item in cached[2]]
    gallery = _history_gallery_uncached(history_item, marker)
    if marker:
        if len(_GALLERY_CACHE) >= _GALLERY_CACHE_LIMIT:
            _GALLERY_CACHE.clear()
        _GALLERY_CACHE[marker] = (history_item, _GALLERY_REVISION, gallery)
    return gallery


def _history_gallery_uncached(history_item: dict[str, Any], job_id: str = "") -> list[dict[str, str]]:
    outputs = history_item.get("outputs", {})
    if not isinstance(outputs, dict):
        return []
    done_ms = _history_completion_time(history_item)

    gallery: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        images = node_output.get("images", [])
        if not isinstance(images, list):
            continue
        for item in images:
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            filename = str(item.get("filename", ""))
            subfolder = str(item.get("subfolder", ""))
            output_type = str(item.get("type", "output"))
            key = (filename, subfolder, output_type)
            if key in seen:
                continue
            favorite = _is_favorite(job_id, filename, subfolder, output_type)
            if favorite:
                _ensure_favorite_copy(job_id, filename, subfolder, output_type)
            fresh = _media_item_fresh(item, done_ms)
            fav_copy = _favorite_file_path(job_id, filename)
            if not fresh and not (favorite and fav_copy and fav_copy.is_file()):
                continue
            seen.add(key)
            entry_item = {
                "filename": filename,
                "subfolder": subfolder,
                "type": output_type,
                "mediaType": "images",
                "favorite": favorite,
            }
            if not fresh and favorite:
                entry_item["source"] = "favorite"
                entry_item["jobId"] = job_id
            gallery.append(entry_item)
    json_meta = {(name, sub, kind) for _job, name, sub, kind in _favorites_for_job(job_id)}
    seen_names = {item["filename"] for item in gallery}
    for filename in _favorite_disk_files(job_id):
        if filename in seen_names:
            for item in gallery:
                if item["filename"] == filename:
                    item["favorite"] = True
            continue
        subfolder = ""
        output_type = "output"
        for name, sub, kind in json_meta:
            if name == filename:
                subfolder, output_type = sub, kind
                break
        gallery.append({
            "filename": filename,
            "subfolder": subfolder,
            "type": output_type,
            "mediaType": "images",
            "favorite": True,
            "source": "favorite",
            "jobId": job_id,
        })
        seen_names.add(filename)
    return gallery


def _history_model_name(entry: dict[str, Any]) -> str:
    """Extract the checkpoint/unet model filename from a history entry's prompt."""
    prompt = entry.get("prompt") if isinstance(entry, dict) else None
    if isinstance(prompt, (list, tuple)) and len(prompt) > 2:
        prompt = prompt[2]
    if not isinstance(prompt, dict):
        return ""
    for node in prompt.values():
        inputs = None
        if isinstance(node, dict):
            inputs = node.get("inputs")
        elif isinstance(node, (list, tuple)) and len(node) > 1:
            inputs = node[1]
        if not isinstance(inputs, dict):
            continue
        for key in ("ckpt_name", "unet_name", "model_name"):
            value = inputs.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


def _entry_extra(entry: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    prompt_tuple = entry.get("prompt")
    if isinstance(prompt_tuple, (list, tuple)) and len(prompt_tuple) > 3 and isinstance(prompt_tuple[3], dict):
        return prompt_tuple[3]
    return {}


def _entry_prompt_graph(entry: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    prompt_tuple = entry.get("prompt")
    if isinstance(prompt_tuple, (list, tuple)) and len(prompt_tuple) > 2 and isinstance(prompt_tuple[2], dict):
        return prompt_tuple[2]
    if isinstance(entry.get("prompt"), dict):
        return entry["prompt"]
    return {}


def _entry_preset(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    extra = _entry_extra(entry)
    remote = extra.get("mobile_remote")
    if not isinstance(remote, dict):
        return None
    preset = remote.get("preset")
    return preset if isinstance(preset, dict) and preset else None


def _entry_seed(entry: dict[str, Any] | None) -> str:
    extra = _entry_extra(entry)
    remote = extra.get("mobile_remote") if isinstance(extra.get("mobile_remote"), dict) else {}
    values = remote.get("values") if isinstance(remote, dict) else {}
    if isinstance(values, dict):
        for key, value in values.items():
            tail = str(key).rsplit(":", 1)[-1].rsplit("::", 1)[-1]
            if tail in {"seed", "noise_seed"} and value not in (None, "", "__random__"):
                return str(value)
    graph = _entry_prompt_graph(entry)
    for node in graph.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for key in ("seed", "noise_seed"):
            value = inputs.get(key)
            if value not in (None, "", "__random__") and not isinstance(value, list):
                return str(value)
    return ""


def _entry_positive_prompt(entry: dict[str, Any] | None) -> str:
    preset = _entry_preset(entry)
    if isinstance(preset, dict) and preset.get("prompt"):
        return str(preset.get("prompt") or "")
    graph = _entry_prompt_graph(entry)
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", "")).lower()
        meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
        title = str(meta.get("title", ""))
        if "negative" in class_type or "negative" in title.lower() or "反向" in title or "负面" in title:
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        text = inputs.get("text") or inputs.get("prompt")
        if isinstance(text, str) and text.strip():
            return text
    extra = _entry_extra(entry)
    remote = extra.get("mobile_remote") if isinstance(extra.get("mobile_remote"), dict) else {}
    values = remote.get("values") if isinstance(remote, dict) else {}
    if isinstance(values, dict):
        for key, value in values.items():
            tail = str(key).rsplit(":", 1)[-1]
            if tail in {"text", "prompt", "positive", "positive_prompt"} and isinstance(value, str) and value.strip():
                return value
    return ""


def _decorate_job(
    job: dict[str, Any],
    history_item: dict[str, Any] | None = None,
) -> dict[str, Any]:
    decorated = dict(job)
    workflow_id = str(job.get("workflow_id", ""))
    if workflow_id:
        try:
            record = _load_record(workflow_id)
            decorated["workflow_name"] = record.get("name", "手机工作流")
        except (FileNotFoundError, ValueError, OSError, json.JSONDecodeError):
            pass

    if isinstance(history_item, dict):
        model_name = _history_model_name(history_item)
        if model_name:
            decorated["model_name"] = model_name
        prompt_tuple = history_item.get("prompt", [])
        if isinstance(prompt_tuple, (list, tuple)) and len(prompt_tuple) > 3:
            extra_data = prompt_tuple[3]
            if isinstance(extra_data, dict):
                remote_data = extra_data.get("mobile_remote", {})
                if isinstance(remote_data, dict) and remote_data.get("workflow_name"):
                    decorated["workflow_name"] = str(remote_data["workflow_name"])
        gallery = _history_gallery(history_item, str(job.get("id", "")))
        decorated["gallery"] = gallery
        if gallery:
            decorated["preview_output"] = dict(gallery[0])
        elif not _media_item_exists(decorated.get("preview_output")):
            decorated["preview_output"] = None

    if "workflow_name" not in decorated:
        decorated["workflow_name"] = "电脑端任务"
    source = history_item
    if not isinstance(source, dict) and isinstance(job.get("workflow"), dict):
        workflow_data = job["workflow"]
        source = {
            "prompt": [
                0,
                job.get("id"),
                workflow_data.get("prompt", {}),
                workflow_data.get("extra_data", {}),
            ]
        }
    if isinstance(source, dict):
        decorated["positive_prompt"] = _entry_positive_prompt(source)
        decorated["seed"] = _entry_seed(source)
        decorated["preset"] = _entry_preset(source)
    return _apply_favorite_meta(decorated, str(job.get("id", "")))


def _decorate_queue_job(
    job: dict[str, Any],
    history_item: dict[str, Any] | None,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    """排队中/运行中的任务：补上模型名与提示词。

    这些任务还不在 history 里，_decorate_job 拿不到提示词，队列页就只剩兜底标题
    （每张卡片都一样）。这里用队列快照补字段，不碰 gallery/preview——
    队列卡片只显示图标，历史那套缩略图装饰在这里没有意义。
    """
    decorated = _decorate_job(job, history_item)
    if isinstance(history_item, dict) or not isinstance(snapshot, dict):
        return decorated
    model_name = _history_model_name(snapshot)
    if model_name:
        decorated["model_name"] = model_name
    prompt = _entry_positive_prompt(snapshot)
    if prompt:
        decorated["positive_prompt"] = prompt
    extra_data = _entry_extra(snapshot)
    remote = extra_data.get("mobile_remote") if isinstance(extra_data, dict) else None
    if isinstance(remote, dict) and remote.get("workflow_name"):
        decorated["workflow_name"] = str(remote["workflow_name"])
    return decorated


def _compact_json(value: Any, max_length: int = 4000) -> Any:
    if isinstance(value, str):
        return value if len(value) <= max_length else value[:max_length]
    if isinstance(value, dict):
        return {str(key): _compact_json(item, max_length) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_compact_json(item, max_length) for item in value]
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)


def _history_entry_time(entry: dict[str, Any]) -> int:
    try:
        return int(entry["prompt"][3].get("create_time", 0) or 0)
    except (IndexError, TypeError, ValueError, AttributeError, KeyError):
        return 0


def _keep_newest_plus_pins(
    items: list[tuple[str, Any]],
    pinned: set[str],
    limit: int,
    time_of,
) -> list[tuple[str, Any]]:
    """Keep the newest `limit` items, then any older pinned favorites."""
    ordered = sorted(items, key=lambda item: time_of(item[1]), reverse=True)
    selected: list[tuple[str, Any]] = []
    seen: set[str] = set()
    for key, item in ordered:
        if len(selected) >= limit:
            break
        selected.append((key, item))
        seen.add(key)
    for key, item in ordered:
        if key in seen or key not in pinned:
            continue
        selected.append((key, item))
        seen.add(key)
    selected.sort(key=lambda item: time_of(item[1]), reverse=True)
    return selected


def _mark_favorite_extra(jobs: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """Newest `limit` completed jobs are the history page; older favorites are extra."""
    completed = [
        job for job in jobs
        if str(job.get("status") or "") not in {"pending", "in_progress"}
    ]
    completed.sort(key=lambda job: job.get("create_time") or 0, reverse=True)
    core = {str(job.get("id", "")) for job in completed[:limit]}
    for job in jobs:
        status = str(job.get("status") or "")
        if status in {"pending", "in_progress"}:
            job["favorite_extra"] = False
        else:
            job["favorite_extra"] = str(job.get("id", "")) not in core
    return jobs


FAVORITE_EXTRA_MAX = 400   # 首屏最多额外带这么多收藏任务，防收藏量极大时把首屏撑回去


def _favorite_extra_jobs(
    entries: list[dict[str, Any]],
    present_ids: set[str],
    history: dict[str, Any],
    favorite_ids: set[str],
) -> list[dict[str, Any]]:
    """首屏额外带上收藏任务，全部标成 favorite_extra。

    动机：手机端首屏只拉最近 N 条，而收藏往往散落在很旧的位置
    （实测本机 158 个收藏任务没有一个落在最新 60 条里），
    不额外带上的话「只看收藏」视图会直接变成空白。
    手机端的按时间列表会把 favorite_extra 过滤掉，只有收藏视图会显示它们，
    所以正常历史列表不受影响；翻页也不会再重复带（客户端按 id 去重）。
    """
    extras: list[dict[str, Any]] = []
    for entry in entries:
        if len(extras) >= FAVORITE_EXTRA_MAX:
            break
        job_id = entry["id"]
        if job_id in present_ids or job_id not in favorite_ids:
            continue
        if entry["kind"] == "favorite":
            job = _favorite_only_job(job_id)
        elif entry["kind"] == "live":
            job = _decorate_job(entry["job"], history.get(job_id))
        else:
            job = _decorate_job(_persisted_job(job_id, entry["entry"]), entry["entry"])
        if job is None:
            continue
        job["favorite_extra"] = True
        extras.append(job)
    return extras


def _history_entry_status(entry: dict[str, Any]) -> str:
    status_info = entry.get("status") or {}
    interrupted = False
    messages = status_info.get("messages") or []
    for message in messages:
        if isinstance(message, (list, tuple)) and message and message[0] == "execution_interrupted":
            interrupted = True
    if status_info.get("status_str") == "error":
        return "cancelled" if interrupted else "failed"
    return "completed"


def _load_history_index() -> dict[str, dict[str, Any]]:
    global _HISTORY_LOADED
    with _HISTORY_LOCK:
        if _HISTORY_LOADED:
            return _HISTORY_CACHE
        try:
            data = _read_json(HISTORY_INDEX_PATH)
            entries = data.get("jobs", {})
            if isinstance(entries, dict):
                for key, item in entries.items():
                    if isinstance(item, dict):
                        _HISTORY_CACHE[str(key)] = item
        except (OSError, ValueError):
            LOG.debug("[Mobile Remote] no readable history index yet")
        _HISTORY_LOADED = True
        return _HISTORY_CACHE


def _persist_history_index() -> None:
    pinned = _favorite_job_ids()
    with _HISTORY_LOCK:
        pruned = dict(_keep_newest_plus_pins(
            list(_HISTORY_CACHE.items()),
            pinned,
            HISTORY_MAX_ITEMS,
            _history_entry_time,
        ))
        if pruned.keys() != _HISTORY_CACHE.keys():
            _HISTORY_CACHE.clear()
            _HISTORY_CACHE.update(pruned)
        snapshot = copy.deepcopy(_HISTORY_CACHE)
    try:
        _write_json_atomic(
            HISTORY_INDEX_PATH,
            {"schema": 1, "saved_at": int(time.time() * 1000), "jobs": snapshot},
        )
    except OSError:
        LOG.exception("[Mobile Remote] failed to persist history index")


def _scrub_stale_history_images(live_ids: set[str]) -> bool:
    """Drop stale history images without holding the history lock during file checks."""
    _load_favorites()
    # A toggle must not race this maintenance pass: otherwise an old favorite snapshot
    # could delete a newly pinned image (or retain an image that was just unpinned).
    with _FAVORITE_TOGGLE_LOCK:
        with _FAVORITES_LOCK:
            fav_keys = set(_FAVORITES)
        pinned = {job_id for job_id, _n, _s, _t in fav_keys if job_id}
        # Keep only references under the history lock. Entries are replaced on writes;
        # deep-copy each entry outside the lock before doing filesystem checks.
        with _HISTORY_LOCK:
            references = {str(prompt_id): entry for prompt_id, entry in _HISTORY_CACHE.items()}
        decisions: dict[str, dict[str, Any] | None] = {}
        originals: dict[str, Any] = {}
        for prompt_id, reference in references.items():
            entry = copy.deepcopy(reference)
            originals[prompt_id] = reference
            if not isinstance(entry, dict):
                decisions[prompt_id] = None
                continue
            outputs = entry.get("outputs")
            if not isinstance(outputs, dict):
                continue
            done_ms = _history_completion_time(entry)
            content_left = False
            for node_output in outputs.values():
                if not isinstance(node_output, dict):
                    continue
                images = node_output.get("images")
                if isinstance(images, list):
                    kept = []
                    for image in images:
                        if not isinstance(image, dict) or not image.get("filename"):
                            continue
                        filename = str(image.get("filename", ""))
                        subfolder = str(image.get("subfolder", "") or "")
                        type_name = str(image.get("type", "output") or "output")
                        if _favorite_key(prompt_id, filename, subfolder, type_name) in fav_keys or _media_item_fresh(image, done_ms):
                            kept.append(image)
                            content_left = True
                    if len(kept) != len(images):
                        node_output["images"] = kept
                elif any(value for key, value in node_output.items() if key != "images"):
                    content_left = True
            if not content_left and prompt_id not in live_ids and prompt_id not in pinned:
                decisions[prompt_id] = None
            else:
                decisions[prompt_id] = entry
        changed = False
        with _HISTORY_LOCK:
            for prompt_id, candidate in decisions.items():
                current = _HISTORY_CACHE.get(prompt_id)
                if current is not originals.get(prompt_id):
                    continue
                if candidate is None:
                    _HISTORY_CACHE.pop(prompt_id, None)
                    changed = True
                elif candidate != current:
                    _HISTORY_CACHE[prompt_id] = candidate
                    changed = True
    if changed:
        _bump_gallery_revision()
    return changed


def _persist_history_index_if_due() -> None:
    """历史索引写一次是 10.6MB / 约 1.2 秒，后台维护不必每轮都落盘。"""
    global _HISTORY_PERSIST_AT
    now = time.monotonic()
    if now - _HISTORY_PERSIST_AT < HISTORY_PERSIST_INTERVAL:
        return
    _HISTORY_PERSIST_AT = now
    _persist_history_index()


def _sync_history_from_live_unlocked(maintenance: bool = True) -> None:
    try:
        from server import PromptServer

        history = PromptServer.instance.prompt_queue.get_history(max_items=HISTORY_MAX_ITEMS)
    except Exception:
        return
    _load_history_index()
    changed = False
    history_changed = False
    with _HISTORY_LOCK:
        for prompt_id, item in history.items():
            if not isinstance(item, dict):
                continue
            compact = _compact_json(
                {
                    "prompt": item.get("prompt", []),
                    "outputs": item.get("outputs", {}),
                    "status": item.get("status"),
                }
            )
            if _HISTORY_CACHE.get(str(prompt_id)) != compact:
                _HISTORY_CACHE[str(prompt_id)] = compact
                changed = True
                history_changed = True
    if history_changed:
        _bump_gallery_revision()
    if not maintenance:
        # 读取接口只更新内存缓存：重写 10.6MB 索引、重写上百个收藏元数据文件
        # 都是后台定时器（每 15 秒）该干的活，放在请求路径里会把接口拖到好几秒。
        return
    if _scrub_stale_history_images({str(pid) for pid in history.keys()}):
        changed = True
        # Scrubbing is a durable deletion; do not let the periodic throttle
        # leave the in-memory cleanup to resurrect after a restart.
        _persist_history_index()
    if changed:
        _persist_history_index_if_due()
    _backfill_favorite_meta()


def _sync_history_from_live(maintenance: bool = True) -> None:
    """Serialize live-history refreshes from the timer and request workers."""
    if maintenance:
        with _HISTORY_SYNC_LOCK:
            _sync_history_from_live_unlocked(True)
        return
    # 读取接口绝不排队等后台维护：抢不到锁就先用现有缓存返回。
    # 否则每 15 秒后台一开始维护，这一批请求就集体被挡住好几秒。
    if not _HISTORY_SYNC_LOCK.acquire(blocking=False):
        return
    try:
        _sync_history_from_live_unlocked(False)
    finally:
        _HISTORY_SYNC_LOCK.release()


def _persisted_job(job_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    prompt_tuple = entry.get("prompt", [])
    prompt = prompt_tuple[2] if len(prompt_tuple) > 2 and isinstance(prompt_tuple[2], dict) else {}
    extra_data = prompt_tuple[3] if len(prompt_tuple) > 3 and isinstance(prompt_tuple[3], dict) else {}
    workflow_id = ""
    workflow_info = extra_data.get("extra_pnginfo", {})
    if isinstance(workflow_info, dict) and isinstance(workflow_info.get("workflow"), dict):
        workflow_id = str(workflow_info["workflow"].get("id", "") or "")
    images: list[dict[str, Any]] = []
    done_ms = _history_completion_time(entry)
    for node_output in (entry.get("outputs") or {}).values():
        if not isinstance(node_output, dict):
            continue
        for image in node_output.get("images", []) or []:
            if isinstance(image, dict) and image.get("filename") and _media_item_fresh(image, done_ms):
                images.append(dict(image))
    preview = dict(images[0]) if images else None
    if preview is not None:
        preview["mediaType"] = "images"
    return {
        "id": str(job_id),
        "status": _history_entry_status(entry),
        "priority": 0,
        "create_time": _history_entry_time(entry),
        "outputs_count": len(images),
        "previewable_outputs_count": len(images),
        "preview_output": preview,
        "workflow_id": workflow_id,
        "model_name": _history_model_name(entry),
        "persisted": True,
        "workflow": {"prompt": prompt, "extra_data": extra_data},
    }


def _history_sync_tick() -> None:
    global _HISTORY_TIMER_STARTED
    try:
        _sync_history_from_live()
    except Exception:
        LOG.exception("[Mobile Remote] history sync failed")
    timer = threading.Timer(HISTORY_SYNC_INTERVAL, _history_sync_tick)
    timer.daemon = True
    timer.start()
    _HISTORY_TIMER_STARTED = True


def _outputs_contain_media(entry: Any, filename: str, subfolder: str, type_name: str) -> bool:
    if not isinstance(entry, dict):
        return False
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return False
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        images = node_output.get("images")
        if not isinstance(images, list):
            continue
        for image in images:
            if not isinstance(image, dict):
                continue
            if (
                str(image.get("filename", "")) == filename
                and str(image.get("subfolder", "") or "") == subfolder
                and str(image.get("type", "output") or "output") == type_name
            ):
                return True
    return False


def _outputs_contain_fresh_media(entry: Any, filename: str, subfolder: str, type_name: str) -> bool:
    if not isinstance(entry, dict):
        return False
    done_ms = _history_completion_time(entry)
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return False
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        images = node_output.get("images")
        if not isinstance(images, list):
            continue
        for image in images:
            if not isinstance(image, dict):
                continue
            if (str(image.get("filename", "")) == filename
                    and str(image.get("subfolder", "") or "") == subfolder
                    and str(image.get("type", "output") or "output") == type_name):
                return _media_item_fresh(image, done_ms)
    return False


def _media_belongs_to_job_without_favorites(job_id: str, filename: str, subfolder: str, type_name: str) -> bool:
    """Authorize against live/history output metadata, never against a toggle record."""
    job_id = str(job_id or "")
    filename = str(filename or "")
    subfolder = str(subfolder or "")
    type_name = str(type_name or "output") or "output"
    if not job_id or not filename:
        return False
    try:
        from server import PromptServer

        live = PromptServer.instance.prompt_queue.get_history().get(job_id)
    except Exception:
        live = None
    if _outputs_contain_fresh_media(live, filename, subfolder, type_name):
        return True
    _load_history_index()
    with _HISTORY_LOCK:
        cached = _HISTORY_CACHE.get(job_id)
    return _outputs_contain_fresh_media(cached, filename, subfolder, type_name)


def _media_belongs_to_job(job_id: str, filename: str, subfolder: str, type_name: str) -> bool:
    """Compatibility wrapper for callers that need a strict source check."""
    return _media_belongs_to_job_without_favorites(job_id, filename, subfolder, type_name)


def _sanitize_job_detail(job: dict[str, Any]) -> dict[str, Any]:
    """Keep phone-detail scalars; drop graph extras, traceback, and raw node IO."""
    sanitized = dict(job)
    sanitized.pop("outputs", None)
    sanitized.pop("execution_status", None)
    workflow = sanitized.get("workflow")
    if isinstance(workflow, dict):
        prompt = workflow.get("prompt") if isinstance(workflow.get("prompt"), dict) else {}
        allowed_inputs = {"width", "height", "steps", "cfg", "denoise", "seed", "noise_seed",
                          "ckpt_name", "unet_name", "model_name", "vae_name", "sampler_name",
                          "scheduler", "batch_size"}
        safe_prompt = {}
        for node_id, node in prompt.items():
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                continue
            inputs = {
                key: value for key, value in node["inputs"].items()
                if key in allowed_inputs and isinstance(value, (str, int, float, bool))
            }
            if inputs:
                safe_prompt[node_id] = {"inputs": inputs}
        sanitized["workflow"] = {"prompt": safe_prompt}
    error = sanitized.get("execution_error")
    if isinstance(error, dict):
        safe_error = {key: error[key] for key in ("type", "exception_message", "node_id", "node_type", "prompt_id") if key in error}
        data = error.get("data")
        if isinstance(data, dict):
            safe_error["data"] = {
                key: data[key]
                for key in ("exception_message", "node_id", "node_type", "prompt_id")
                if key in data
            }
        sanitized["execution_error"] = safe_error
    return sanitized


def _mobile_job_summary(job: dict[str, Any]) -> dict[str, Any]:
    """Return only fields needed to render the mobile job list/gallery."""
    fields = (
        "id",
        "status",
        "priority",
        "create_time",
        "outputs_count",
        "previewable_outputs_count",
        "preview_output",
        "workflow_id",
        "workflow_name",
        "model_name",
        "persisted",
        "seed",
        "gallery",
        "favorite_extra",
    )
    summary = {field: job[field] for field in fields if field in job}
    # 队列页要显示提示词；历史页不显示，别把几百条提示词塞进列表响应。
    if str(job.get("status") or "") in {"pending", "in_progress"} and job.get("positive_prompt"):
        summary["positive_prompt"] = job["positive_prompt"]
    return summary


def _history_cache_items() -> list[tuple[str, dict[str, Any]]]:
    """Copy cache entries under the lock before decorating them outside it."""
    with _HISTORY_LOCK:
        return list(_HISTORY_CACHE.items())


def _favorite_only_job(job_id: str) -> dict[str, Any] | None:
    """Build a history card for a favorited job that is no longer in the index."""
    history_item = _history_item_from_favorite_meta(job_id)
    job = _decorate_job(
        {
            "id": job_id,
            "status": "completed",
            "priority": 0,
            "create_time": _history_entry_time(history_item),
            "persisted": True,
        },
        history_item,
    )
    gallery = job.get("gallery") or []
    if not gallery:
        return None
    job["outputs_count"] = len(gallery)
    job["previewable_outputs_count"] = len(gallery)
    job["preview_output"] = dict(gallery[0])
    if not job.get("workflow_name"):
        job["workflow_name"] = "收藏"
    return job


def _json_bytes(payload: Any) -> bytes:
    """紧凑 UTF-8 JSON，字段顺序和 web.json_response 一致。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _gzip_json_bytes(payload: Any, raw: bytes | None = None) -> bytes:
    """把 payload 压成 gzip（level 1）。

    level 1 是实测最划算的一档：382KB 的任务列表压到约 35KB、耗时 1 毫秒出头；
    再高一档省不了多少字节，CPU 却要翻几倍。raw 可以传入已序列化好的字节，省一次 json.dumps。
    """
    return gzip.compress(raw if raw is not None else _json_bytes(payload), 1)


def _client_accepts_gzip(request: web.Request) -> bool:
    return "gzip" in str(request.headers.get("Accept-Encoding", "")).lower()


def _mobile_jobs_response(payload: dict[str, Any], accepts_gzip: bool) -> web.Response:
    """把任务列表包成响应；序列化和压缩都在这里做完（调用方丢进线程执行）。"""
    raw = _json_bytes(payload)
    body = raw
    compressed = False
    if accepts_gzip and len(raw) > GZIP_MIN_BYTES:
        packed = _gzip_json_bytes(payload, raw)
        # 压不动的东西（已经很小或不重复）就别压，白让手机解一遍
        if len(packed) < len(raw):
            body = packed
            compressed = True
    headers = dict(NO_CACHE)
    headers["Content-Type"] = "application/json"
    if compressed:
        headers["Content-Encoding"] = "gzip"
    return web.Response(body=body, headers=headers)


def _get_mobile_jobs_payload(
    limit: int,
    offset: int,
    statuses: list[str],
    summary: bool = False,
    include_favorite_extras: bool = True,
) -> dict[str, Any]:
    """Build the mobile jobs response away from the aiohttp event loop.

    分页分两步走：
    1) 先拼出「完整列表」并按 create_time 倒序排好。这一步只用 id/status/create_time
       这类便宜字段（实时任务由 get_all_jobs 给出，历史条目只取索引里的时间戳），
       绝不调用 _decorate_job —— 它要查磁盘、建缩略图，几百条跑一遍就是好几秒。
    2) 先按 offset/limit 切片，再把「运行中/排队中」无条件并进这一页，
       最后也只装饰这一页。
    """
    from comfy_execution.jobs import get_all_jobs

    running, pending, history = _queue_snapshot()
    _sync_history_from_live(maintenance=False)
    # 队列里的任务不在 history 里：先把快照按 prompt_id 存下来，给它们补提示词与模型名。
    live_prompts: dict[str, dict[str, Any]] = {}
    for item in list(running) + list(pending):
        if isinstance(item, (list, tuple)) and len(item) > 3 and isinstance(item[1], str):
            live_prompts[item[1]] = {"prompt": list(item)}
    # limit=None：先拿全量轻量 job，切片留到最后。否则 total 只是实时任务数，
    # offset 也永远落不到恢复出来的历史条目上。
    live_jobs, _live_total = get_all_jobs(
        running,
        pending,
        history,
        status_filter=statuses or None,
        sort_by="created_at",
        sort_order="desc",
        limit=None,
        offset=0,
    )
    live_ids = set(history.keys()) | {str(job.get("id", "")) for job in live_jobs}
    entries: list[dict[str, Any]] = [
        {
            "kind": "live",
            "id": str(job.get("id", "")),
            "status": str(job.get("status") or ""),
            "create_time": job.get("create_time") or 0,
            "job": job,
        }
        for job in live_jobs
    ]
    # 恢复出来的历史条目（索引里 570 多条）：排序阶段只读时间戳和状态，不建缩略图。
    for prompt_id, entry in _history_cache_items():
        if prompt_id in live_ids:
            continue
        entries.append({
            "kind": "restored",
            "id": str(prompt_id),
            "status": _history_entry_status(entry),
            "create_time": _history_entry_time(entry),
            "entry": entry,
        })
    favorite_ids = _favorite_job_ids() if include_favorite_extras else set()
    present_ids = {entry["id"] for entry in entries}
    for job_id in favorite_ids:
        # 只有收藏夹还留着图、实时历史和索引都没有的任务
        if job_id in present_ids:
            continue
        present_ids.add(job_id)
        # 实时历史和索引里都没有、只有收藏夹还留着图的任务。这里仍属排序阶段：
        # 最多读一份 job.json 拿 create_time，缩略图等它真被翻到再建。
        entries.append({
            "kind": "favorite",
            "id": job_id,
            "status": "completed",
            "create_time": _history_entry_time(_history_item_from_favorite_meta(job_id)),
        })
    entries.sort(key=lambda entry: entry["create_time"] or 0, reverse=True)
    total = len(entries)

    page = entries[offset: offset + limit]
    page_ids = {entry["id"] for entry in page}
    # 「运行中/排队中」不受 limit 限制：它们的 create_time 可能很老、落在窗口外，
    # 但手机端的队列页必须永远看得到它们。
    for entry in entries:
        if entry["status"] not in {"pending", "in_progress"} or entry["id"] in page_ids:
            continue
        page_ids.add(entry["id"])
        page.append(entry)
    page.sort(key=lambda entry: entry["create_time"] or 0, reverse=True)

    jobs_out: list[dict[str, Any]] = []
    for entry in page:
        if entry["kind"] == "live":
            jobs_out.append(_decorate_queue_job(
                entry["job"], history.get(entry["id"]), live_prompts.get(entry["id"]),
            ))
        elif entry["kind"] == "restored":
            jobs_out.append(_decorate_job(_persisted_job(entry["id"], entry["entry"]), entry["entry"]))
        else:
            # 收藏兜底卡片：自带一次 _decorate_job；拿不到任何图就不进列表。
            extra = _favorite_only_job(entry["id"])
            if extra is not None:
                jobs_out.append(extra)
    jobs_out = _mark_favorite_extra(jobs_out, limit)
    # 只有收藏筛选打开时才额外带回旧收藏，普通历史请求不做这份扫描和装饰。
    if offset == 0 and favorite_ids:
        jobs_out.extend(_favorite_extra_jobs(
            entries,
            {str(job.get("id", "")) for job in jobs_out},
            history,
            favorite_ids,
        ))
    if summary:
        jobs_out = [_mobile_job_summary(job) for job in jobs_out]
    return {
        "ok": True,
        "jobs": jobs_out,
        "total": total,
        "has_more": offset + limit < total,
    }


# 手机页面的静态资源。i18n.js 是手机页和电脑端面板共用的同一份实现，
# 只保留一份，免得两边的翻译逻辑各自跑偏。
_MOBILE_ASSET_FILES = {
    "app.js",
    "advanced.js",
    "advanced.css",
    "settings-sync.js",
    "preset-catalog.js",
    "preset-engine.js",
    "progress-sync.js",
    "styles.css",
    "icon.svg",
    "prompt-presets.json",
}
_SHARED_ASSET_FILES: dict[str, Path] = {"i18n.js": PLUGIN_ROOT / "web" / "i18n.js"}


def _asset_response(filename: str) -> web.StreamResponse:
    if filename in _SHARED_ASSET_FILES:
        path = _SHARED_ASSET_FILES[filename]
    elif filename in _MOBILE_ASSET_FILES:
        path = MOBILE_ROOT / filename
    else:
        raise web.HTTPNotFound()
    if not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=NO_CACHE)


def _locale_response(lang: str) -> web.StreamResponse:
    """界面词典：zh 直接返回空对象（中文就是源码原文），其余读 i18n/<lang>.json。"""
    name = str(lang or "").strip().lower()
    if name not in MOBILE_LOCALES:
        raise web.HTTPNotFound()
    if name == "zh":
        return web.json_response({}, headers=NO_CACHE)
    path = I18N_ROOT / f"{name}.json"
    if not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=NO_CACHE)


def register_routes() -> None:
    global ROUTES_REGISTERED
    if ROUTES_REGISTERED:
        return

    from server import PromptServer
    from .progress_snapshot import ProgressSnapshotUnavailable, snapshot_progress

    routes = PromptServer.instance.routes
    _install_locale_middleware(PromptServer.instance)

    @routes.get("/mobile")
    @routes.get("/mobile/")
    async def mobile_index(_request: web.Request) -> web.StreamResponse:
        return web.FileResponse(MOBILE_ROOT / "index.html", headers=NO_CACHE)

    @routes.get("/mobile/assets/{filename}")
    async def mobile_asset(request: web.Request) -> web.StreamResponse:
        return _asset_response(request.match_info["filename"])

    @routes.get("/mobile/api/i18n/{lang}")
    async def mobile_locale(request: web.Request) -> web.StreamResponse:
        return _locale_response(str(request.match_info.get("lang") or ""))

    @routes.get("/mobile/manifest.webmanifest")
    async def mobile_manifest(_request: web.Request) -> web.Response:
        manifest = {
            "name": "ComfyUI Mobile Remote",
            "short_name": "Comfy Remote",
            "start_url": "/mobile",
            "scope": "/mobile",
            "display": "standalone",
            "background_color": "#111312",
            "theme_color": "#111312",
            "icons": [
                {
                    "src": "/mobile/assets/icon.svg",
                    "sizes": "any",
                    "type": "image/svg+xml",
                    "purpose": "any maskable",
                }
            ],
        }
        return web.json_response(manifest, headers=NO_CACHE, content_type="application/manifest+json")

    @routes.get("/mobile/api/status")
    async def mobile_status(request: web.Request) -> web.Response:
        from server import PromptServer

        running, pending = PromptServer.instance.prompt_queue.get_current_queue_volatile()
        gpu: dict[str, Any] = {}
        try:
            import comfy.model_management as model_management

            device = model_management.get_torch_device()
            total = int(model_management.get_total_memory(device))
            free = int(model_management.get_free_memory(device))
            gpu = {
                "name": model_management.get_torch_device_name(device),
                "total": total,
                "free": free,
                "used": max(0, total - free),
            }
        except Exception as exc:
            LOG.debug("[Mobile Remote] GPU stats unavailable: %s", exc)

        try:
            from comfy.cli_args import args

            port = int(args.port)
        except (ImportError, TypeError, ValueError):
            port = 8188
        tailscale_ips = await asyncio.to_thread(_tailscale_ips)
        return web.json_response(
            {
                "ok": True,
                "online": True,
                "running": len(running),
                "pending": len(pending),
                "gpu": gpu,
                "tailscale_ips": tailscale_ips,
                "mobile_urls": [f"http://{address}:{port}/mobile" for address in tailscale_ips],
                "version": _plugin_version(),
                "time": int(time.time() * 1000),
            },
            headers=NO_CACHE,
        )

    @routes.get("/mobile/api/progress")
    async def mobile_progress(_request: web.Request) -> web.Response:
        try:
            snapshot = await asyncio.to_thread(snapshot_progress, PromptServer.instance.prompt_queue)
        except ProgressSnapshotUnavailable as exc:
            LOG.debug("[Mobile Remote] progress snapshot unavailable: %s", exc)
            return web.json_response(
                {
                    "ok": False,
                    "error": "progress_snapshot_unavailable",
                    "is_idle": False,
                },
                status=503,
                headers=NO_CACHE,
            )
        except Exception:
            LOG.exception("[Mobile Remote] progress snapshot failed")
            return web.json_response(
                {
                    "ok": False,
                    "error": "progress_snapshot_unavailable",
                    "is_idle": False,
                },
                status=503,
                headers=NO_CACHE,
            )
        return web.json_response(snapshot, headers=NO_CACHE)

    @routes.get("/mobile/api/workflows")
    async def mobile_workflows(request: web.Request) -> web.Response:
        # all=1 给电脑端导入卡片用：连"没常驻"的记录一起返回，才知道哪些已经导入过
        include_hidden = request.query.get("all") == "1"
        return web.json_response(
            {"ok": True, "workflows": _list_records(include_hidden)}, headers=NO_CACHE
        )

    @routes.post("/mobile/api/update/apply")
    async def mobile_apply_update(request: web.Request) -> web.Response:
        force = request.query.get("force") == "1"
        current = _plugin_version()
        try:
            latest = await asyncio.to_thread(_fetch_remote_version)
        except Exception as exc:
            return web.json_response({"ok": False, "error": _t("读取远端版本失败：{error}", error=exc)})
        if not force and not _version_newer(latest, current):
            return web.json_response({"ok": False, "error": _t("已经是最新版本 {version}", version=current)})
        expect = str(request.query.get("version") or "").lstrip("vV")
        if expect and expect != latest:
            return web.json_response(
                {"ok": False, "error": _t("远端版本已变成 {version}，请重新点一次「检查更新」", version=latest)}
            )
        zip_url = f"https://github.com/{UPDATE_REPO}/archive/refs/tags/v{latest}.zip"
        try:
            archive_path = await asyncio.to_thread(_download_update_zip, zip_url)
            plan = await asyncio.to_thread(_update_plan, archive_path)
        except Exception as exc:
            LOG.info("[Mobile Remote] update download failed: %s", exc)
            return web.json_response({"ok": False, "error": _t("下载或解压失败：{error}", error=exc)})
        confirm = request.query.get("confirm") == "1"
        if not confirm:
            LOG.info(
                "[Mobile Remote] update plan: %d replace / %d skip (dry run)",
                len(plan["replace"]),
                len(plan["skip"]),
            )
            return web.json_response(
                {
                    "ok": True,
                    "dry_run": True,
                "current": current,
                "latest": latest,
                "zip_url": zip_url,
                    "replace_count": len(plan["replace"]),
                    "skip_count": len(plan["skip"]),
                    "will_replace": plan["replace"][:400],
                    "will_skip": plan["skip"][:80],
                }
            )
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup_root = PLUGIN_ROOT / ".runtime" / f"backup-{stamp}-{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        result = await asyncio.to_thread(_apply_update_and_prune, plan["root"], PLUGIN_ROOT, backup_root)
        if not result["ok"]:
            return web.json_response({"ok": False, "error": _t(result["error"]), "copied": len(result["copied"])})
        LOG.info(
            "[Mobile Remote] updated to %s: %d files, backup at %s",
            latest,
            len(result["copied"]),
            backup_root,
        )
        return web.json_response(
            {
                "ok": True,
                "dry_run": False,
                "updated_to": latest,
                "copied_count": len(result["copied"]),
                "backup": str(backup_root.relative_to(PLUGIN_ROOT)),
                "message": _t("更新完成，请重启 ComfyUI 生效"),
            }
        )

    @routes.get("/mobile/api/update")
    async def mobile_check_update(request: web.Request) -> web.Response:
        force = request.query.get("force") == "1"
        now = int(time.time() * 1000)
        cached = UPDATE_CACHE.get("data")
        if not force and isinstance(cached, dict) and (now - int(UPDATE_CACHE.get("at") or 0)) < UPDATE_TTL_MS:
            return web.json_response(cached)
        current = _plugin_version()
        try:
            latest = await asyncio.to_thread(_fetch_remote_version)
        except Exception as exc:
            LOG.info("[Mobile Remote] update check failed: %s", exc)
            return web.json_response(
                {"ok": False, "current": current, "error": _t("连接 GitHub 失败：{error}", error=exc)}
            )
        payload = {
            "ok": True,
            "current": current,
            "latest": latest,
            "has_update": _version_newer(latest, current),
            "name": f"v{latest}",
            "notes": "",
            "published_at": "",
            "html_url": f"https://github.com/{UPDATE_REPO}/releases/tag/v{latest}",
            "zip_url": f"https://github.com/{UPDATE_REPO}/archive/refs/tags/v{latest}.zip",
        }
        UPDATE_CACHE.update({"at": now, "data": payload})
        return web.json_response(payload)

    @routes.post("/mobile/api/workflows/active")
    async def mobile_set_active_workflow(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            payload = {}
        raw = (payload or {}).get("sources") if isinstance(payload, dict) else None
        if not isinstance(raw, list):
            raw = []
        sources = sorted({str(item)[:500] for item in raw if isinstance(item, str) and item.strip()})
        try:
            _write_json_atomic(ACTIVE_WORKFLOW_PATH, {"sources": sources, "at": int(time.time() * 1000)})
        except OSError as exc:
            return _json_error("记录当前工作流失败", 500, str(exc))
        return web.json_response({"ok": True, "sources": sources})

    @routes.post("/mobile/api/desktop/commands")
    async def mobile_submit_desktop_command(request: web.Request) -> web.Response:
        """手机端「高级」页改了值：排一条指令，等电脑端在它自己的画布上照做。

        服务端只负责排队和校验，绝不自己去碰画布；真正的应用永远发生在用户自己那台电脑上。
        """
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            payload = None
        command, error, status, reason = _desktop_command_submit(payload)
        if command is None:
            return _json_error(error, status, {"reason": reason})
        LOG.info(
            "[Mobile Remote] desktop command queued: node %s %s",
            command["node_id"], command["input"],
        )
        return web.json_response({"ok": True, "pending": _desktop_commands_count()}, headers=NO_CACHE)

    @routes.get("/mobile/api/desktop/commands")
    async def mobile_pending_desktop_commands(request: web.Request) -> web.Response:
        """电脑端扩展领取待办（约 1 秒一次）。返回未执行的指令，领了不删。"""
        body, error = _desktop_commands_pending_payload(request.query.get("workflow_id", ""))
        if body is None:
            return _json_error(error)
        return web.json_response(body, headers=NO_CACHE)

    @routes.post("/mobile/api/desktop/commands/ack")
    async def mobile_ack_desktop_commands(request: web.Request) -> web.Response:
        """电脑端确认这些指令已经落到画布上（或确认画布上找不到对应节点），可以删了。"""
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            payload = None
        body, error = _desktop_commands_ack_payload(payload)
        if body is None:
            return _json_error(error)
        return web.json_response(body, headers=NO_CACHE)

    @routes.post("/mobile/api/workflows/sync")
    async def mobile_sync_workflow(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return _json_error("工作流数据不是有效 JSON")
        if not isinstance(payload, dict):
            return _json_error("工作流数据格式错误")

        record, error = _record_from_payload(payload)
        if record is None:
            return _json_error(error)
        if _blocked_workflow_name(record["name"]):
            # 未保存的工作流不进手机列表；顺手把历史遗留的清掉
            _purge_blocked_records()
            LOG.info("[Mobile Remote] skipped unsaved workflow %r", record["name"])
            return web.json_response(
                {"ok": True, "skipped": True, "workflow": {"id": "", "name": record["name"], "field_count": 0}}
            )
        # 电脑端打开工作流时，别把导入过的「常驻」标记弄丢
        _carry_over_flags(record)
        try:
            _write_json_atomic(_record_path(record["id"]), record)
        except OSError as exc:
            LOG.exception("[Mobile Remote] failed to store workflow")
            return _json_error("保存工作流失败", 500, str(exc))
        _remember_open_source(record["source"])
        fields = _infer_fields(record["prompt"])
        return web.json_response(
            {
                "ok": True,
                "workflow": {
                    "id": record["id"],
                    "name": record["name"],
                    "pinned": bool(record.get("pinned")),
                    "field_count": len(fields),
                    "node_count": len(record["prompt"]),
                },
            },
            headers=NO_CACHE,
        )

    @routes.post("/mobile/api/workflows/import")
    async def mobile_import_workflow(request: web.Request) -> web.Response:
        """电脑端选中一个"已保存到磁盘"的工作流导入进来，标成常驻：电脑端不开手机也能用。"""
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return _json_error("工作流数据不是有效 JSON")
        if not isinstance(payload, dict):
            return _json_error("工作流数据格式错误")

        record, error = _record_from_payload(payload)
        if record is None:
            return _json_error(error)
        if _blocked_workflow_name(record["name"]):
            return _json_error("这个工作流没有保存到磁盘，不能导入")

        _carry_over_flags(record)
        now = int(time.time() * 1000)
        record["pinned"] = True
        record["pinned_at"] = int(record.get("pinned_at") or now)
        record["imported_at"] = now
        try:
            _write_json_atomic(_record_path(record["id"]), record)
        except OSError as exc:
            LOG.exception("[Mobile Remote] failed to import workflow")
            return _json_error("导入工作流失败", 500, str(exc))
        fields = _infer_fields(record["prompt"])
        LOG.info(
            "[Mobile Remote] imported %r (%s)",
            record["name"],
            record.get("library_path") or record["source"],
        )
        return web.json_response(
            {
                "ok": True,
                "workflow": {
                    "id": record["id"],
                    "name": record["name"],
                    "source": record["source"],
                    "pinned": True,
                    "field_count": len(fields),
                    "node_count": len(record["prompt"]),
                },
            },
            headers=NO_CACHE,
        )

    @routes.post("/mobile/api/workflows/{workflow_id}/pin")
    async def mobile_pin_workflow(request: web.Request) -> web.Response:
        """开关「常驻」。取消常驻不删记录，只是它又变回"电脑端打开才显示"。"""
        workflow_id = request.match_info["workflow_id"]
        try:
            _record_path(workflow_id)
        except ValueError:
            return _json_error("工作流编号无效")
        record = _existing_record(workflow_id)
        if not record:
            return _json_error("工作流不存在", 404)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            payload = {}
        pinned = bool(payload.get("pinned")) if isinstance(payload, dict) else False
        record["pinned"] = pinned
        if pinned:
            record["pinned_at"] = int(time.time() * 1000)
        else:
            record.pop("pinned_at", None)
        try:
            _write_json_atomic(_record_path(workflow_id), record)
        except OSError as exc:
            return _json_error("保存常驻状态失败", 500, str(exc))
        return web.json_response({"ok": True, "pinned": pinned}, headers=NO_CACHE)

    @routes.get("/mobile/api/workflows/{workflow_id}")
    async def mobile_workflow_detail(request: web.Request) -> web.Response:
        workflow_id = request.match_info["workflow_id"]
        try:
            record = _load_record(workflow_id)
        except ValueError:
            return _json_error("工作流编号无效")
        except FileNotFoundError:
            return _json_error("工作流不存在", 404)
        prompt = record.get("prompt", {})
        node_titles: dict[str, str] = {}
        if isinstance(prompt, dict):
            for node_id, node in prompt.items():
                if not isinstance(node, dict):
                    continue
                meta = node.get("_meta")
                title = meta.get("title") if isinstance(meta, dict) else None
                node_titles[str(node_id)] = str(title or node.get("class_type") or node_id)
        fields = _infer_fields(prompt)
        return web.json_response(
            {
                "ok": True,
                "workflow": {
                    "id": workflow_id,
                    "name": record.get("name", "未命名工作流"),
                    "source": record.get("source", ""),
                    "synced_at": record.get("synced_at", 0),
                    "node_count": len(prompt) if isinstance(prompt, dict) else 0,
                    "fields": fields,
                    "node_titles": node_titles,
                    # 「高级」页用：节点顺序、分组、连线关系
                    "graph": _workflow_graph(prompt, record.get("workflow"), fields),
                },
            },
            headers=NO_CACHE,
        )

    @routes.delete("/mobile/api/workflows/{workflow_id}")
    async def mobile_delete_workflow(request: web.Request) -> web.Response:
        try:
            path = _record_path(request.match_info["workflow_id"])
        except ValueError:
            return _json_error("工作流编号无效")
        if path.is_file():
            path.unlink()
        return web.json_response({"ok": True}, headers=NO_CACHE)

    @routes.get("/mobile/api/drafts/{workflow_id}")
    async def mobile_get_draft(request: web.Request) -> web.Response:
        try:
            path = _draft_path(request.match_info["workflow_id"])
        except ValueError:
            return _json_error("工作流编号无效")
        try:
            data = _read_json(path)
        except (FileNotFoundError, ValueError, OSError):
            return web.json_response({"ok": True, "values": {}}, headers=NO_CACHE)
        values = data.get("values", {})
        return web.json_response(
            {"ok": True, "values": values if isinstance(values, dict) else {}},
            headers=NO_CACHE,
        )

    @routes.post("/mobile/api/drafts/{workflow_id}")
    async def mobile_save_draft(_request: web.Request) -> web.Response:
        # Old mobile tabs must not keep performing the previous 700ms disk writes.
        return _json_error("设置同步已升级，请刷新手机页面后继续。", 409)

    @routes.post("/mobile/api/jobs")
    async def mobile_create_job(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return _json_error("任务数据不是有效 JSON")
        if not isinstance(payload, dict):
            return _json_error("任务数据格式错误")

        workflow_id = str(payload.get("workflow_id", ""))
        client_id = str(payload.get("client_id", ""))[:128] or f"mobile-{uuid.uuid4().hex}"
        values = payload.get("values", {})
        if not isinstance(values, dict):
            return _json_error("参数格式错误")
        preset = payload.get("preset")
        if not isinstance(preset, dict):
            preset = None
        try:
            record = _load_record(workflow_id)
        except ValueError:
            return _json_error("工作流编号无效")
        except FileNotFoundError:
            return _json_error("工作流不存在", 404)

        prompt = copy.deepcopy(record.get("prompt", {}))
        fields = _infer_fields(prompt)
        field_map = {field["id"]: field for field in fields}
        submitted: dict[str, Any] = {}
        try:
            for field_id, incoming in values.items():
                key = str(field_id)
                field = field_map.get(key)
                if field is not None:
                    converted = _coerce_value(incoming, field)
                    prompt[field["node_id"]]["inputs"][field["input"]] = converted
                    submitted[key] = converted
                    continue
                # 「高级」页能编辑的输入比 fields 多（被 NODE_HIDDEN_INPUTS 藏起来的、
                # 自制节点自己的控件……），所以任意合法的「节点id::输入名」都要收下：
                # 节点或输入不存在、值转不动就跳过这一条，不报错也不动 prompt。
                applied, converted = _apply_submitted_input(prompt, key, incoming)
                if applied:
                    submitted[key] = converted
        except (TypeError, ValueError) as exc:
            return _json_error(str(exc))

        result, error = await _enqueue_prompt(
            prompt=prompt,
            client_id=client_id,
            workflow=record.get("workflow", {}),
            workflow_id=workflow_id,
            workflow_name=str(record.get("name", "手机工作流")),
            submitted_values=submitted,
            preset=preset,
        )
        if error is not None:
            return _json_error("ComfyUI 拒绝了这个工作流", 400, error)
        return web.json_response(result, headers=NO_CACHE)

    @routes.get("/mobile/api/jobs")
    async def mobile_jobs(request: web.Request) -> web.Response:
        from comfy_execution.jobs import JobStatus

        try:
            limit = min(max(int(request.query.get("limit", "60")), 1), 500)
            offset = max(int(request.query.get("offset", "0")), 0)
        except ValueError:
            return _json_error("分页参数无效")
        requested_status = request.query.get("status", "")
        statuses = [part for part in requested_status.split(",") if part in JobStatus.ALL]
        summary = True
        include_favorite_extras = request.query.get("favorites") == "1"
        payload = await asyncio.to_thread(
            _get_mobile_jobs_payload,
            limit,
            offset,
            statuses,
            summary,
            include_favorite_extras,
        )
        # 几百 KB 的响应手机端每 8 秒拉一次：序列化和 gzip 都放线程里，别占事件循环。
        return await asyncio.to_thread(
            _mobile_jobs_response,
            payload,
            _client_accepts_gzip(request),
        )

    @routes.post("/mobile/api/favorites/toggle")
    async def mobile_toggle_favorite(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return _json_error("收藏数据不是有效 JSON")
        if not isinstance(payload, dict):
            return _json_error("收藏数据格式错误")
        filename = str(payload.get("filename", ""))
        subfolder = str(payload.get("subfolder", "") or "")
        type_name = str(payload.get("type", "output") or "output")
        job_id = str(payload.get("job_id", "") or "")
        if not filename or not job_id:
            return _json_error("缺少图片信息")
        result = await asyncio.to_thread(_toggle_favorite_result, job_id, filename, subfolder, type_name)
        if not result["ok"]:
            return _json_error(result["error"])
        return web.json_response({"ok": True, "favorite": result["favorite"]}, headers=NO_CACHE)

    @routes.get("/mobile/api/favorites/file")
    async def mobile_favorite_file(request: web.Request) -> web.StreamResponse:
        job_id = str(request.query.get("job_id", "") or "")
        filename = str(request.query.get("filename", "") or "")
        path = _favorite_file_path(job_id, filename)
        if path is None or not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers=MEDIA_CACHE)

    @routes.get("/mobile/api/preview")
    async def mobile_preview(request: web.Request) -> web.Response:
        job_id = str(request.query.get("job_id", "") or "")
        filename = str(request.query.get("filename", "") or "")
        path = _favorite_file_path(job_id, filename) if job_id else None
        if path is None or not path.is_file():
            path = _resolve_media_path(
                filename,
                str(request.query.get("subfolder", "") or ""),
                str(request.query.get("type", "output") or "output"),
            )
        if path is None or not path.is_file():
            raise web.HTTPNotFound()
        body = await asyncio.to_thread(_preview_webp_bytes, path)
        if not body:
            return web.FileResponse(path, headers=MEDIA_CACHE)
        return web.Response(body=body, content_type="image/webp", headers=MEDIA_CACHE)

    @routes.post("/mobile/api/outputs/delete")
    async def mobile_delete_output(request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return _json_error("删除数据不是有效 JSON")
        if not isinstance(payload, dict):
            return _json_error("删除数据格式错误")
        filename = str(payload.get("filename", ""))
        subfolder = str(payload.get("subfolder", "") or "")
        type_name = str(payload.get("type", "output") or "output")
        job_id = str(payload.get("job_id", "") or "")
        if not job_id:
            return _json_error("缺少任务编号")
        result = await asyncio.to_thread(_delete_output_result, job_id, filename, subfolder, type_name)
        if not result["ok"]:
            return _json_error(result["error"], result.get("status", 400))
        return web.json_response({"ok": True}, headers=NO_CACHE)

    @routes.get("/mobile/api/jobs/{job_id}")
    async def mobile_job_detail(request: web.Request) -> web.Response:
        job_id = request.match_info["job_id"]
        result = await asyncio.to_thread(_job_detail_result, job_id)
        if not result["ok"]:
            return _json_error(result["error"], result.get("status", 404))
        return web.json_response({"ok": True, "job": result["job"]}, headers=NO_CACHE)

    @routes.post("/mobile/api/jobs/{job_id}/cancel")
    async def mobile_cancel_job(request: web.Request) -> web.Response:
        from comfy_execution.jobs import cancel_job
        from server import PromptServer

        job_id = request.match_info["job_id"]
        running, pending, history = _queue_snapshot()
        queue = PromptServer.instance.prompt_queue
        result = cancel_job(
            job_id,
            running,
            pending,
            history,
            interrupt=queue.interrupt_if_running,
            dequeue=lambda prompt_id: queue.delete_queue_item(lambda item: item[1] == prompt_id),
        )
        return web.json_response({"ok": True, "result": result}, headers=NO_CACHE)

    @routes.post("/mobile/api/jobs/stop-all")
    async def mobile_stop_all_jobs(request: web.Request) -> web.Response:
        """先清空排队中的任务，再中断正在执行的那一个。

        顺序不能反：先中断当前任务的话，队列里的下一条会立刻开始跑，
        紧接着的清队列就会把它一起清掉——用户点一次按钮本意是"全部停下"。
        两个动作都在队列锁内完成，中途不会有新任务插进来。
        """
        from server import PromptServer

        removed, interrupted = _stop_all_jobs(PromptServer.instance.prompt_queue)
        return web.json_response({
            "ok": True,
            "removed": removed,
            "interrupted": interrupted,
        }, headers=NO_CACHE)

    @routes.post("/mobile/api/jobs/{job_id}/retry")
    async def mobile_retry_job(request: web.Request) -> web.Response:
        from comfy_execution.jobs import get_job

        running, pending, history = _queue_snapshot()
        old_job = get_job(request.match_info["job_id"], running, pending, history)
        if old_job is None:
            return _json_error("任务不存在", 404)
        workflow_data = old_job.get("workflow", {})
        prompt = copy.deepcopy(workflow_data.get("prompt", {})) if isinstance(workflow_data, dict) else {}
        extra_data = workflow_data.get("extra_data", {}) if isinstance(workflow_data, dict) else {}
        if not prompt:
            return _json_error("这个任务还没有可重试的数据", 409)
        remote_data = extra_data.get("mobile_remote", {}) if isinstance(extra_data, dict) else {}
        workflow_id = str(remote_data.get("workflow_id") or old_job.get("workflow_id") or "")
        workflow_name = str(remote_data.get("workflow_name") or old_job.get("workflow_name") or "重新生成")
        workflow = extra_data.get("extra_pnginfo", {}).get("workflow", {}) if isinstance(extra_data, dict) else {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        client_id = str(payload.get("client_id", ""))[:128] if isinstance(payload, dict) else ""
        client_id = client_id or f"mobile-{uuid.uuid4().hex}"
        result, error = await _enqueue_prompt(
            prompt=prompt,
            client_id=client_id,
            workflow=workflow,
            workflow_id=workflow_id or hashlib.sha256(workflow_name.encode()).hexdigest()[:20],
            workflow_name=workflow_name,
            submitted_values=remote_data.get("values", {}) if isinstance(remote_data, dict) else {},
            preset=remote_data.get("preset") if isinstance(remote_data, dict) else None,
        )
        if error is not None:
            return _json_error("ComfyUI 拒绝了重试任务", 400, error)
        return web.json_response(result, headers=NO_CACHE)

    from .phone_settings import register_phone_settings

    register_phone_settings(PromptServer.instance)

    try:
        from .connections import register_connections

        register_connections(PromptServer.instance)
    except Exception:
        LOG.exception("[Mobile Remote] optional connection panel initialization failed")

    ROUTES_REGISTERED = True
    WORKFLOW_ROOT.mkdir(parents=True, exist_ok=True)
    if not _HISTORY_TIMER_STARTED:
        _sync_history_from_live()
        sync_timer = threading.Timer(HISTORY_SYNC_INTERVAL, _history_sync_tick)
        sync_timer.daemon = True
        sync_timer.start()
    LOG.info("[Mobile Remote] ready at /mobile (no graph nodes registered)")
