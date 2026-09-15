from __future__ import annotations

import asyncio
import copy
import hashlib
import ipaddress
import json
import logging
import os
import random
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web

PLUGIN_ROOT = Path(__file__).resolve().parent
MOBILE_ROOT = PLUGIN_ROOT / "mobile"
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
MEDIA_CACHE = {"Cache-Control": "private, max-age=86400"}
LOG = logging.getLogger("comfyui.mobile_remote")
ROUTES_REGISTERED = False
TAILSCALE_CACHE: tuple[float, list[str]] = (0.0, [])
_HISTORY_CACHE: dict[str, dict[str, Any]] = {}
_HISTORY_LOCK = threading.Lock()
_HISTORY_SYNC_LOCK = threading.Lock()
_HISTORY_LOADED = False
_HISTORY_TIMER_STARTED = False
_FAVORITES: set[tuple[str, str, str, str]] = set()
_FAVORITES_LOCK = threading.Lock()
_FAVORITES_LOADED = False

# 缩略图列表缓存：同一份历史条目 + 同一版收藏状态只算一次。
# /mobile/api/jobs 每次要给几百条历史建缩略图，逐个查磁盘是最大的开销之一。
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


def _json_error(message: str, status: int = 400, details: Any = None) -> web.Response:
    payload: dict[str, Any] = {"ok": False, "error": message}
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


def _tailscale_ips() -> list[str]:
    global TAILSCALE_CACHE
    now = time.monotonic()
    if now - TAILSCALE_CACHE[0] < 60:
        return TAILSCALE_CACHE[1]

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
    return TAILSCALE_CACHE[1]


def _input_specs(class_type: str) -> dict[str, dict[str, Any]]:
    try:
        import nodes

        node_class = nodes.NODE_CLASS_MAPPINGS.get(class_type)
        if node_class is None:
            return {}
        raw = node_class.INPUT_TYPES()
    except Exception:
        return {}

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
                options = [item for item in token if isinstance(item, (str, int, float, bool))]
                type_name = "ENUM"
            else:
                type_name = getattr(token, "value", None) or str(token or "")
            specs[str(name)] = {
                "required": section == "required",
                "type": str(type_name).upper(),
                "options": options,
                "config": config,
            }
    return specs


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
            raise ValueError(f"{field['label']} 必须是开或关")
    elif isinstance(original, int) and not isinstance(original, bool):
        result = int(value)
    elif isinstance(original, float):
        result = float(value)
    else:
        result = str(value)
        if len(result) > 200000:
            raise ValueError(f"{field['label']} 内容过长")

    minimum = field.get("min")
    maximum = field.get("max")
    if isinstance(result, (int, float)):
        if isinstance(minimum, (int, float)) and result < minimum:
            raise ValueError(f"{field['label']} 不能小于 {minimum}")
        if isinstance(maximum, (int, float)) and result > maximum:
            raise ValueError(f"{field['label']} 不能大于 {maximum}")

    options = field.get("options", [])
    if options and result not in options:
        comparable = {str(item): item for item in options}
        if str(result) in comparable:
            result = comparable[str(result)]
        else:
            raise ValueError(f"{field['label']} 的选项无效")
    return result


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
        return None, {"type": "no_prompt", "message": "工作流数据无效"}

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
        if any(item[0] == str(job_id or "") and item[1] == str(filename or "") for item in _FAVORITES):
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
        ImageFile.LOAD_TRUNCATED_IMAGES = True
        with Image.open(path) as img:
            img.load()
            img.thumbnail((size, size))
            if img.mode not in {"RGB", "L"}:
                img = img.convert("RGB")
            buffer = BytesIO()
            img.save(buffer, format="WEBP", quality=72, method=4)
            return buffer.getvalue()
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
    if not dest.is_file():
        source = _resolve_media_path(filename, subfolder, type_name)
        if source is None or not source.is_file():
            return None
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
        except OSError:
            LOG.exception("[Mobile Remote] failed to copy favorite file")
            return None
    if dest.is_file():
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
    _sync_history_from_live()
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
        if isinstance(entry, dict) and _strip_images_from_outputs(entry.get("outputs"), filename, subfolder, type_name):
            changed = True
    if changed:
        _persist_history_index()


def _history_gallery(history_item: dict[str, Any] | None, job_id: str = "") -> list[dict[str, str]]:
    if not isinstance(history_item, dict):
        return []
    marker = str(job_id or "")
    if marker:
        cached = _GALLERY_CACHE.get(marker)
        if cached is not None and cached[0] is history_item and cached[1] == _GALLERY_REVISION:
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
        try:
            _write_json_atomic(
                HISTORY_INDEX_PATH,
                {"schema": 1, "saved_at": int(time.time() * 1000), "jobs": _HISTORY_CACHE},
            )
        except OSError:
            LOG.exception("[Mobile Remote] failed to persist history index")


def _scrub_stale_history_images(live_ids: set[str]) -> bool:
    """Drop cached images whose file is gone or was replaced by name reuse."""
    _load_favorites()
    with _FAVORITES_LOCK:
        fav_keys = set(_FAVORITES)
    pinned = {job_id for job_id, _n, _s, _t in fav_keys if job_id}
    changed = False
    with _HISTORY_LOCK:
        for prompt_id in list(_HISTORY_CACHE.keys()):
            entry = _HISTORY_CACHE[prompt_id]
            if not isinstance(entry, dict):
                _HISTORY_CACHE.pop(prompt_id, None)
                changed = True
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
                        # 收藏的图永远保留；其余按「文件还在不在」判断
                        if _favorite_key(str(prompt_id), filename, subfolder, type_name) in fav_keys:
                            kept.append(image)
                            content_left = True
                            continue
                        if _media_item_fresh(image, done_ms):
                            kept.append(image)
                            content_left = True
                    if len(kept) != len(images):
                        node_output["images"] = kept
                        changed = True
                elif any(value for key, value in node_output.items() if key != "images"):
                    content_left = True
            if not content_left and str(prompt_id) not in live_ids and str(prompt_id) not in pinned:
                _HISTORY_CACHE.pop(prompt_id, None)
                changed = True
    if changed:
        _bump_gallery_revision()
    return changed


def _sync_history_from_live_unlocked(maintenance: bool = True) -> None:
    try:
        from server import PromptServer

        history = PromptServer.instance.prompt_queue.get_history(max_items=HISTORY_MAX_ITEMS)
    except Exception:
        return
    _load_history_index()
    changed = False
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
    if _scrub_stale_history_images({str(pid) for pid in history.keys()}):
        changed = True
    if not maintenance:
        # 读取接口只更新内存缓存：重写 10.6MB 索引、重写上百个收藏元数据文件
        # 都是后台定时器（每 15 秒）该干的活，放在请求路径里会把接口拖到好几秒。
        return
    if changed:
        _persist_history_index()
    _backfill_favorite_meta()


def _sync_history_from_live(maintenance: bool = True) -> None:
    """Serialize live-history refreshes from the timer and request workers."""
    with _HISTORY_SYNC_LOCK:
        _sync_history_from_live_unlocked(maintenance)


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
    return {field: job[field] for field in fields if field in job}


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


def _get_mobile_jobs_payload(
    limit: int,
    offset: int,
    statuses: list[str],
    summary: bool = False,
) -> dict[str, Any]:
    """Build the mobile jobs response away from the aiohttp event loop."""
    from comfy_execution.jobs import get_all_jobs

    running, pending, history = _queue_snapshot()
    _sync_history_from_live(maintenance=False)
    jobs, total = get_all_jobs(
        running,
        pending,
        history,
        status_filter=statuses or None,
        sort_by="created_at",
        sort_order="desc",
        limit=limit,
        offset=offset,
    )
    decorated = [
        _decorate_job(job, history.get(str(job.get("id", ""))))
        for job in jobs
    ]
    live_ids = set(history.keys()) | {str(job.get("id", "")) for job in jobs}
    restored = [
        _decorate_job(_persisted_job(prompt_id, entry), entry)
        for prompt_id, entry in _history_cache_items()
        if prompt_id not in live_ids
    ]
    combined = decorated + restored
    present_ids = {str(job.get("id", "")) for job in combined}
    for job_id in _favorite_job_ids():
        if job_id in present_ids:
            continue
        extra = _favorite_only_job(job_id)
        if extra is None:
            continue
        combined.append(extra)
        present_ids.add(job_id)
    combined = sorted(
        combined,
        key=lambda job: job.get("create_time") or 0,
        reverse=True,
    )
    pinned_ids = _favorite_job_ids()
    jobs_out = [
        job
        for _job_id, job in _keep_newest_plus_pins(
            [(str(job.get("id", "")), job) for job in combined],
            pinned_ids,
            limit,
            lambda job: job.get("create_time") or 0,
        )
    ]
    jobs_out = _mark_favorite_extra(jobs_out, limit)
    if summary:
        jobs_out = [_mobile_job_summary(job) for job in jobs_out]
    return {
        "ok": True,
        "jobs": jobs_out,
        "total": total + len(restored),
    }


def _asset_response(filename: str) -> web.StreamResponse:
    allowed = {"app.js", "settings-sync.js", "preset-catalog.js", "preset-engine.js", "progress-sync.js", "styles.css", "icon.svg", "prompt-presets.json"}
    if filename not in allowed:
        raise web.HTTPNotFound()
    path = MOBILE_ROOT / filename
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

    @routes.get("/mobile")
    @routes.get("/mobile/")
    async def mobile_index(_request: web.Request) -> web.StreamResponse:
        return web.FileResponse(MOBILE_ROOT / "index.html", headers=NO_CACHE)

    @routes.get("/mobile/assets/{filename}")
    async def mobile_asset(request: web.Request) -> web.StreamResponse:
        return _asset_response(request.match_info["filename"])

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
        tailscale_ips = _tailscale_ips()
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
            return web.json_response({"ok": False, "error": f"读取远端版本失败：{exc}"})
        if not force and not _version_newer(latest, current):
            return web.json_response({"ok": False, "error": f"已经是最新版本 {current}"})
        expect = str(request.query.get("version") or "").lstrip("vV")
        if expect and expect != latest:
            return web.json_response(
                {"ok": False, "error": f"远端版本已变成 {latest}，请重新点一次「检查更新」"}
            )
        zip_url = f"https://github.com/{UPDATE_REPO}/archive/refs/tags/v{latest}.zip"
        try:
            archive_path = await asyncio.to_thread(_download_update_zip, zip_url)
            plan = await asyncio.to_thread(_update_plan, archive_path)
        except Exception as exc:
            LOG.info("[Mobile Remote] update download failed: %s", exc)
            return web.json_response({"ok": False, "error": f"下载或解压失败：{exc}"})
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
        backup_root = PLUGIN_ROOT / ".runtime" / f"backup-{stamp}"
        result = await asyncio.to_thread(_apply_update_files, plan["root"], PLUGIN_ROOT, backup_root)
        if not result["ok"]:
            return web.json_response({"ok": False, "error": result["error"], "copied": len(result["copied"])})
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
                "message": "更新完成，请重启 ComfyUI 生效",
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
                {"ok": False, "current": current, "error": f"连接 GitHub 失败：{exc}"}
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
        return web.json_response(
            {
                "ok": True,
                "workflow": {
                    "id": workflow_id,
                    "name": record.get("name", "未命名工作流"),
                    "source": record.get("source", ""),
                    "synced_at": record.get("synced_at", 0),
                    "node_count": len(prompt) if isinstance(prompt, dict) else 0,
                    "fields": _infer_fields(prompt),
                    "node_titles": node_titles,
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
                field = field_map.get(str(field_id))
                if field is None:
                    continue
                converted = _coerce_value(incoming, field)
                prompt[field["node_id"]]["inputs"][field["input"]] = converted
                submitted[field_id] = converted
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
        payload = await asyncio.to_thread(
            _get_mobile_jobs_payload,
            limit,
            offset,
            statuses,
            summary,
        )
        return web.json_response(payload, headers=NO_CACHE)

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
