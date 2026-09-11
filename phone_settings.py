"""Shared, bounded phone preferences; importable without ComfyUI or its nodes.

Call register_phone_settings(PromptServer.instance) once during route registration.
The returned PhoneSettingsStore loads lazily; its synchronous snapshot()/save()
methods must run in a worker thread when called from asynchronous code.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

ROOT = Path(__file__).resolve().parent
PREFIX = "comfy-mobile-remote."
DRAFT_PREFIX = PREFIX + "draft."
WORKFLOW_ID = re.compile(r"[0-9a-f]{20}\Z")
MAX_BYTES = 2 * 1024 * 1024
MAX_KEYS = 260
MAX_DRAFTS = 250
MAX_VALUE_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 128 * 1024
MAX_DRAFT_FIELDS = 2048
MAX_PRESET_SLOTS = 256
MAX_CUSTOM_TAGS = 4096
COOLDOWN_MS = 60_000
MAX_SAFE_INTEGER = 2**53 - 1
NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate"}
PREFERENCES = {
    PREFIX + "randomGenerate": {"0", "1"},
    PREFIX + "repeatCount": {str(i) for i in range(1, 11)},
    PREFIX + "favoritesOnly": {"0", "1"},
    PREFIX + "historyCols": {"2", "3", "4"},
    PREFIX + "multiModel": {"0", "1"},
    PREFIX + "fixedSeed": {"0", "1"},
}
FIXED_KEYS = set(PREFERENCES) | {PREFIX + "workflow", PREFIX + "preset", PREFIX + "presetCatalog", PREFIX + "multiModels"}
RESERVED_NAMES = {"__proto__", "prototype", "constructor"}
SENSITIVE_FIELDS = {
    "api_key", "apikey", "authorization", "password", "secret", "token",
    "access_token", "refresh_token",
}
LOG = logging.getLogger("comfyui.mobile_remote.settings")


class SettingsError(Exception):
    def __init__(self, message: str, status: int = 400, snapshot=None, **details):
        super().__init__(message)
        self.status = status
        # Put ok last: a successful snapshot must never turn an error into ok:true.
        self.payload = {**(snapshot or {}), **details, "ok": False, "error": message}


def _integer(value, maximum=MAX_SAFE_INTEGER):
    return type(value) is int and 0 <= value <= maximum


def _text(value, limit=MAX_TEXT_BYTES):
    if not isinstance(value, str):
        raise SettingsError("Setting text must be a string")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError as exc:
        raise SettingsError("Setting text must be valid Unicode") from exc
    if size > limit:
        raise SettingsError("Setting text exceeds its size limit", 413)


def _name(value, limit=256):
    _text(value, limit)
    if not value or any(ord(char) < 32 for char in value):
        raise SettingsError("Invalid setting field name")
    parts = re.split(r"[.:/\\]", value)
    if any(part.lower() in RESERVED_NAMES for part in parts):
        raise SettingsError("Invalid setting field name")


def _no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("Non-finite JSON number")


def _parse_json(value):
    try:
        return json.loads(value, object_pairs_hook=_no_duplicates,
                          parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise SettingsError("Invalid JSON") from exc


def _encode(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise SettingsError("Invalid JSON values") from exc


def _validate_draft(value):
    if not isinstance(value, dict):
        raise SettingsError("Draft must be an object of scalar input values")
    if len(value) > MAX_DRAFT_FIELDS:
        raise SettingsError("Too many draft fields", 413)
    for key, item in value.items():
        _name(key)
        input_name = key.rsplit("::", 1)[-1].lower().replace("-", "_")
        if input_name in SENSITIVE_FIELDS or input_name.startswith("_"):
            raise SettingsError("Draft contains an unsupported input field")
        if isinstance(item, str):
            _text(item)
        elif item is None or type(item) is bool:
            continue
        elif type(item) in (int, float):
            try:
                finite = math.isfinite(item)
            except OverflowError:
                finite = False
            if not finite:
                raise SettingsError("Draft numbers must be finite")
        else:
            raise SettingsError("Draft values must be scalar")


def _validate_tag_list(tags, label, *, limit=256, nonempty=True, strict=False):
    if not isinstance(tags, list):
        raise SettingsError(f"Preset {label} must be an array of strings")
    if len(tags) > limit:
        raise SettingsError(f"Too many preset {label}", 413)
    seen = set()
    for tag in tags:
        _text(tag, 4096)
        if strict and tag != tag.strip():
            raise SettingsError(f"Preset {label} must contain trimmed strings")
        if (nonempty and not tag) or tag in seen:
            raise SettingsError(f"Preset {label} must be unique nonempty strings")
        seen.add(tag)


def _validate_tag_map(value, label, *, strict=False):
    if not isinstance(value, dict):
        raise SettingsError(f"Preset {label} must be an object")
    if len(value) > MAX_PRESET_SLOTS:
        raise SettingsError("Too many preset slots", 413)
    count = 0
    for key, tags in value.items():
        _name(key, 128)
        if strict and key != key.strip():
            raise SettingsError(f"Preset {label} slot ids must be trimmed")
        if not isinstance(tags, list):
            raise SettingsError(f"Preset {label} tags must be arrays of strings")
        count += len(tags)
        if len(tags) > 256 or count > MAX_CUSTOM_TAGS:
            raise SettingsError("Too many custom preset tags", 413)
        _validate_tag_list(tags, label, strict=strict)


def _validate_mutex(value, *, strict=False):
    if not isinstance(value, list):
        raise SettingsError("Preset mutex must be an array")
    if len(value) > 256:
        raise SettingsError("Too many preset mutex groups", 413)
    seen_groups = set()
    for group in value:
        _validate_tag_list(group, "mutex", limit=64, strict=strict)
        if len(group) < 2:
            raise SettingsError("Invalid preset mutex group")
        if strict:
            signature = tuple(sorted(group))
            if signature in seen_groups:
                raise SettingsError("Preset mutex groups must be unique")
            seen_groups.add(signature)


def _validate_skip_categories(value, *, strict=False):
    if not isinstance(value, list):
        raise SettingsError("Preset skipCategories must be an array")
    if len(value) > 256:
        raise SettingsError("Too many preset skip rules", 413)
    seen_rules = set()
    for rule in value:
        allowed = {"whenAny", "skip"} if strict else {"whenAny", "whenTag", "skip"}
        if not isinstance(rule, dict) or set(rule) - allowed:
            raise SettingsError("Invalid preset skip rule")
        if "whenAny" in rule:
            _validate_tag_list(rule["whenAny"], "skip trigger", strict=strict)
            if not rule["whenAny"]:
                raise SettingsError("Invalid preset skip trigger")
        elif "whenTag" in rule and not strict:
            _text(rule["whenTag"], 4096)
            if not rule["whenTag"]:
                raise SettingsError("Invalid preset skip trigger")
        else:
            raise SettingsError("Invalid preset skip trigger")
        skip = rule.get("skip", [])
        _validate_tag_list(skip, "skip list", limit=64, nonempty=True, strict=strict)
        if not skip:
            raise SettingsError("Invalid preset skip list")
        for item in skip:
            _name(item, 128)
        if strict:
            signature = (tuple(rule["whenAny"]), tuple(skip))
            if signature in seen_rules:
                raise SettingsError("Preset skip rules must be unique")
            seen_rules.add(signature)


def _validate_catalog(value, *, strict=False):
    allowed = {"custom", "removed", "removedCustom", "skipped", "mutex", "singletons", "skipCategories"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise SettingsError("Invalid preset catalog")
    for key in ("custom", "removed", "removedCustom", "skipped"):
        if key in value:
            _validate_tag_map(value[key], key, strict=strict)
    if "mutex" in value:
        _validate_mutex(value["mutex"], strict=strict)
    if "singletons" in value:
        _validate_tag_list(value["singletons"], "singletons", strict=strict)
    if "skipCategories" in value:
        _validate_skip_categories(value["skipCategories"], strict=strict)


def _validate_preset(value, *, strict_catalog=True):
    allowed = {"enabled", "slots", "custom", "freeText", "extraText", "catalog"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise SettingsError("Invalid preset object")
    if type(value.get("enabled")) is not bool:
        raise SettingsError("Preset enabled must be a boolean")
    for key in ("freeText", "extraText"):
        _text(value.get(key, ""))
    slots, custom = value.get("slots", {}), value.get("custom", {})
    if not isinstance(slots, dict) or not isinstance(custom, dict):
        raise SettingsError("Preset slots and custom must be objects")
    if len(slots) > MAX_PRESET_SLOTS or len(custom) > MAX_PRESET_SLOTS:
        raise SettingsError("Too many preset slots", 413)
    for key, slot in slots.items():
        _name(key, 128)
        if not isinstance(slot, dict) or set(slot) != {"value", "locked", "ignored"}:
            raise SettingsError("Invalid preset slot")
        _text(slot["value"], 4096)
        if type(slot["locked"]) is not bool or type(slot["ignored"]) is not bool:
            raise SettingsError("Preset slot flags must be booleans")
    count = 0
    for key, tags in custom.items():
        _name(key, 128)
        if not isinstance(tags, list):
            raise SettingsError("Custom preset tags must be arrays of strings")
        count += len(tags)
        if len(tags) > 256 or count > MAX_CUSTOM_TAGS:
            raise SettingsError("Too many custom preset tags", 413)
        _validate_tag_list(tags, "custom", strict=True)
    if "catalog" in value:
        _validate_catalog(value["catalog"], strict=strict_catalog)


def _validate_multi_models(value):
    if not isinstance(value, dict):
        raise SettingsError("多模型列表格式无效")
    if len(value) > MAX_DRAFTS:
        raise SettingsError("Too many workflow drafts", 413)
    for workflow_id, names in value.items():
        if not WORKFLOW_ID.fullmatch(str(workflow_id)):
            raise SettingsError("Invalid workflow id")
        if not isinstance(names, list) or len(names) > 20:
            raise SettingsError("多模型数量超出限制")
        seen = set()
        for name in names:
            _text(name, 512)
            if not name or name in seen:
                raise SettingsError("多模型列表无效")
            seen.add(name)


def _validate_key(key):
    if not isinstance(key, str):
        raise SettingsError("Setting keys must be strings")
    if key not in FIXED_KEYS and not (
        key.startswith(DRAFT_PREFIX) and WORKFLOW_ID.fullmatch(key[len(DRAFT_PREFIX):])
    ):
        raise SettingsError("Unsupported setting key")


def _validate_value(key, value):
    _text(value, MAX_VALUE_BYTES)
    if key in PREFERENCES:
        if value not in PREFERENCES[key]:
            raise SettingsError("Invalid preference value")
    elif key == PREFIX + "workflow":
        if value and not WORKFLOW_ID.fullmatch(value):
            raise SettingsError("Invalid workflow id")
    elif key == PREFIX + "preset":
        _validate_preset(_parse_json(value))
    elif key == PREFIX + "presetCatalog":
        _validate_catalog(_parse_json(value), strict=True)
    elif key == PREFIX + "multiModels":
        _validate_multi_models(_parse_json(value))
    else:
        _validate_draft(_parse_json(value))


def _validate_values(values):
    if not isinstance(values, dict):
        raise SettingsError("Settings values must be an object")
    if len(values) > MAX_KEYS:
        raise SettingsError("Too many settings keys", 413)
    drafts = 0
    for key, value in values.items():
        _validate_key(key)
        _validate_value(key, value)
        drafts += key.startswith(DRAFT_PREFIX)
    if drafts > MAX_DRAFTS:
        raise SettingsError("Too many workflow drafts", 413)


def _unique_trimmed_strings(tags):
    normalized = []
    for tag in tags:
        tag = tag.strip()
        if tag and tag not in normalized:
            normalized.append(tag)
    return normalized


def _legacy_normalize_tag_lists(value):
    """Normalize old preset/catalog shapes; new writes remain strict and do not mint presetCatalog."""
    changed = False
    parsed = _parse_json(value) if isinstance(value, str) else value

    def clean_map(container, field):
        nonlocal changed
        if not isinstance(container, dict) or field not in container:
            return
        source = container[field]
        if not isinstance(source, dict):
            return
        cleaned = {}
        for slot, tags in source.items():
            key = slot.strip() if isinstance(slot, str) else slot
            if key != slot:
                changed = True
            if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
                cleaned[key] = tags
                continue
            normalized = _unique_trimmed_strings(tags)
            if normalized != tags:
                changed = True
            if key in cleaned and isinstance(cleaned[key], list) and all(isinstance(tag, str) for tag in cleaned[key]):
                merged = _unique_trimmed_strings(list(cleaned[key]) + normalized)
                if merged != cleaned[key]:
                    changed = True
                cleaned[key] = merged
            else:
                cleaned[key] = normalized
        container[field] = cleaned

    def clean_mutex(container):
        nonlocal changed
        groups = container.get("mutex")
        if not isinstance(groups, list):
            return
        cleaned = []
        seen = set()
        for group in groups:
            if not isinstance(group, list) or not all(isinstance(tag, str) for tag in group):
                cleaned.append(group)
                continue
            normalized = _unique_trimmed_strings(group)
            if normalized != group:
                changed = True
            if len(normalized) < 2:
                changed = True
                continue
            signature = tuple(sorted(normalized))
            if signature in seen:
                changed = True
                continue
            seen.add(signature)
            cleaned.append(normalized)
        if cleaned != groups:
            changed = True
        container["mutex"] = cleaned

    def clean_singletons(container):
        nonlocal changed
        tags = container.get("singletons")
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            return
        normalized = _unique_trimmed_strings(tags)
        if normalized != tags:
            container["singletons"] = normalized
            changed = True

    def clean_skip_rules(container):
        nonlocal changed
        rules = container.get("skipCategories")
        if not isinstance(rules, list):
            return
        cleaned = []
        seen = set()
        for rule in rules:
            if not isinstance(rule, dict) or set(rule) - {"whenAny", "whenTag", "skip"}:
                cleaned.append(rule)
                continue
            when = rule.get("whenAny")
            if when is None and "whenTag" in rule:
                tag = rule.get("whenTag")
                when = [tag] if isinstance(tag, str) else tag
                changed = True
            skip = rule.get("skip")
            if not isinstance(when, list) or not all(isinstance(tag, str) for tag in when):
                cleaned.append(rule)
                continue
            if not isinstance(skip, list) or not all(isinstance(tag, str) for tag in skip):
                cleaned.append(rule)
                continue
            when_n = _unique_trimmed_strings(when)
            skip_n = _unique_trimmed_strings(skip)
            if when_n != when or skip_n != skip or "whenTag" in rule:
                changed = True
            if not when_n or not skip_n:
                changed = True
                continue
            signature = (tuple(when_n), tuple(skip_n))
            if signature in seen:
                changed = True
                continue
            seen.add(signature)
            cleaned.append({"whenAny": when_n, "skip": skip_n})
        if cleaned != rules:
            changed = True
        container["skipCategories"] = cleaned

    if not isinstance(parsed, dict):
        return value, False
    clean_map(parsed, "custom")
    catalog = parsed.get("catalog")
    if isinstance(catalog, dict):
        for field in ("custom", "removed", "removedCustom", "skipped"):
            clean_map(catalog, field)
        clean_mutex(catalog)
        clean_singletons(catalog)
        clean_skip_rules(catalog)
    if not changed:
        return value, False
    return _encode(parsed).decode("utf-8"), True


def _normalize_loaded_values(values):
    """Keep old preset storage usable without forcing the new catalog key."""
    if not isinstance(values, dict):
        return values
    result = dict(values)
    key = PREFIX + "preset"
    if key not in result:
        return result
    normalized, changed = _legacy_normalize_tag_lists(result[key])
    if changed:
        result[key] = normalized
    return result


class PhoneSettingsStore:
    """One process-wide store per registered PromptServer, with an injectable clock.

    clock returns epoch seconds. Only successful changed saves start the global
    60-second cooldown. The exact localStorage strings are kept unchanged.
    """

    def __init__(self, root=None, *, clock: Callable[[], float] | None = None):
        self.root = Path(root) if root is not None else ROOT
        self.path = self.root / "mobile_settings.json"
        self.backup_path = self.root / "mobile_settings.json.bak"
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._loaded = False
        self._load_error = None
        self._values = {}
        self._revision = 0
        self._saved_at = 0
        self._exists = False
        self._committed_bytes = None
        self._from_backup = False

    def _now(self):
        return max(0, int(self._clock() * 1000))

    def _snapshot(self, now):
        return {"ok": True, "revision": self._revision, "saved_at": self._saved_at,
                "exists": self._exists,
                "retry_after_ms": max(0, self._saved_at + COOLDOWN_MS - now)
                if self._exists else 0,
                "values": dict(self._values)}

    @staticmethod
    def _read_bytes(path):
        with path.open("rb") as handle:
            data = handle.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise SettingsError("Settings file exceeds size limit", 413)
        return data

    def _decode_file(self, raw):
        payload = _parse_json(raw)
        if (not isinstance(payload, dict)
                or set(payload) != {"schema", "revision", "saved_at", "values"}
                or type(payload["schema"]) is not int or payload["schema"] != 1
                or not _integer(payload["revision"])
                or not _integer(payload["saved_at"])):
            raise SettingsError("Invalid settings file")
        payload["values"] = _normalize_loaded_values(payload["values"])
        _validate_values(payload["values"])
        return payload

    def _migrate(self):
        values = {}
        for path in sorted((self.root / "drafts").glob("*.json")):
            if len(values) >= MAX_DRAFTS:
                break
            if not WORKFLOW_ID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                data = _parse_json(self._read_bytes(path))
                if not isinstance(data, dict) or "values" not in data:
                    continue
                draft = data["values"]
                _validate_draft(draft)
                serialized = _encode(draft).decode("utf-8")
                _text(serialized, MAX_VALUE_BYTES)
                candidate = {**values, DRAFT_PREFIX + path.stem: serialized}
                # Reserve envelope space so the migrated snapshot is saveable.
                if len(_encode(candidate)) > MAX_BYTES - 1024:
                    continue
                values = candidate
            except (SettingsError, OSError):
                LOG.warning("[Mobile Remote] skipped invalid legacy settings draft")
        self._values = values

    def _load(self):
        if self._loaded:
            if self._load_error:
                raise SettingsError(self._load_error, 503)
            return
        self._loaded = True
        damaged = False
        for path in (self.path, self.backup_path):
            try:
                raw = self._read_bytes(path)
                data = self._decode_file(raw)
            except FileNotFoundError:
                continue
            except (SettingsError, OSError):
                damaged = True
                continue
            self._values = data["values"]
            self._revision = data["revision"]
            self._saved_at = data["saved_at"]
            self._exists = True
            self._committed_bytes = raw
            self._from_backup = path == self.backup_path
            return
        if damaged:
            self._load_error = "\u8bbe\u7f6e\u548c\u5907\u4efd\u8bfb\u53d6\u5931\u8d25\uff0c\u8bf7\u5148\u6062\u590d\u6709\u6548\u6587\u4ef6\u518d\u91cd\u542f\u670d\u52a1"
            raise SettingsError(self._load_error, 503)
        try:
            self._migrate()
        except OSError as exc:
            self._load_error = "\u65e7\u8349\u7a3f\u8bfb\u53d6\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u6587\u4ef6\u6743\u9650"
            raise SettingsError(self._load_error, 503) from exc

    def snapshot(self):
        with self._lock:
            self._load()
            return self._snapshot(self._now())

    @staticmethod
    def _stage(path, raw):
        descriptor, filename = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp",
                                               dir=str(path.parent))
        temporary = Path(filename)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return temporary

    def _commit(self, raw):
        staged = []
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            primary = self._stage(self.path, raw)
            staged.append(primary)
            # Never copy a corrupt primary over the backup used for recovery.
            if self._committed_bytes is not None and not self._from_backup:
                backup = self._stage(self.backup_path, self._committed_bytes)
                staged.append(backup)
                os.replace(backup, self.backup_path)
            os.replace(primary, self.path)
        finally:
            for path in staged:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    LOG.warning("[Mobile Remote] could not remove settings temporary file")

    def save(self, base_revision, changes):
        if not _integer(base_revision):
            raise SettingsError("base_revision must be a nonnegative integer")
        if not isinstance(changes, dict):
            raise SettingsError("changes must be an object")
        if len(changes) > MAX_KEYS:
            raise SettingsError("Too many settings keys", 413)
        if len(_encode({"base_revision": base_revision, "changes": changes})) > MAX_BYTES:
            raise SettingsError("Settings request exceeds size limit", 413)
        with self._lock:
            self._load()
            now = self._now()
            snapshot = self._snapshot(now)
            if base_revision != self._revision:
                raise SettingsError("\u8bbe\u7f6e\u5df2\u88ab\u5176\u4ed6\u8bbe\u5907\u66f4\u65b0\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5", 409,
                                    snapshot, conflict=True)
            values = dict(self._values)
            for key, value in changes.items():
                _validate_key(key)
                if value is None:
                    values.pop(key, None)
                else:
                    _validate_value(key, value)
                    values[key] = value
            _validate_values(values)
            if values == self._values:
                return snapshot
            if snapshot["retry_after_ms"]:
                raise SettingsError("\u6bcf 60 \u79d2\u53ea\u80fd\u4fdd\u5b58\u4e00\u6b21\u8bbe\u7f6e", 429, snapshot)
            if self._revision >= MAX_SAFE_INTEGER:
                raise SettingsError("Settings revision limit reached", 503, snapshot)
            raw = _encode({"schema": 1, "revision": self._revision + 1,
                           "saved_at": now, "values": values})
            if len(raw) > MAX_BYTES:
                raise SettingsError("Total settings exceed size limit", 413)
            try:
                self._commit(raw)
            except OSError as exc:
                LOG.warning("[Mobile Remote] failed to save shared settings")
                raise SettingsError("\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5", 503, snapshot) from exc
            self._values = values
            self._revision += 1
            self._saved_at = now
            self._exists = True
            self._committed_bytes = raw
            self._from_backup = False
            return self._snapshot(now)

    def save_json(self, raw):
        if len(raw) > MAX_BYTES:
            raise SettingsError("Settings request exceeds size limit", 413)
        payload = _parse_json(raw)
        if not isinstance(payload, dict) or set(payload) != {"base_revision", "changes"}:
            raise SettingsError("Expected base_revision and changes")
        return self.save(payload["base_revision"], payload["changes"])


def _error_response(exc):
    headers = dict(NO_CACHE)
    if exc.status == 429:
        headers["Retry-After"] = str(max(1, (exc.payload["retry_after_ms"] + 999) // 1000))
    return web.json_response(exc.payload, status=exc.status, headers=headers)


def register_phone_settings(prompt_server, *, root=None, clock=None):
    """Register GET/POST /mobile/api/settings and return their shared cached store.

    root/clock are optional test hooks. Registration performs no disk operations.
    Repeated registration on the same server returns the existing store.
    """
    existing = getattr(prompt_server, "_mobile_phone_settings_store", None)
    if existing is not None:
        return existing
    store = PhoneSettingsStore(root, clock=clock)

    @prompt_server.routes.get("/mobile/api/settings")
    async def mobile_get_settings(request):
        try:
            payload = await asyncio.to_thread(store.snapshot)
            return web.json_response(payload, headers=NO_CACHE)
        except SettingsError as exc:
            return _error_response(exc)

    @prompt_server.routes.post("/mobile/api/settings")
    async def mobile_save_settings(request):
        try:
            if request.content_type != "application/json":
                raise SettingsError("Content-Type must be application/json", 415)
            if request.content_length is not None and request.content_length > MAX_BYTES:
                raise SettingsError("Settings request exceeds size limit", 413)
            raw = bytearray()
            async for chunk in request.content.iter_chunked(64 * 1024):
                raw.extend(chunk)
                if len(raw) > MAX_BYTES:
                    raise SettingsError("Settings request exceeds size limit", 413)
            payload = await asyncio.to_thread(store.save_json, bytes(raw))
            return web.json_response(payload, headers=NO_CACHE)
        except SettingsError as exc:
            return _error_response(exc)
        except (ValueError, UnicodeError, web.HTTPBadRequest):
            return _error_response(SettingsError("Invalid settings request"))

    prompt_server._mobile_phone_settings_store = store
    return store
