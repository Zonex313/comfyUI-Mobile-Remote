"""Read-only live progress snapshots for ComfyUI Mobile Remote.

This module deliberately has no ComfyUI imports at module load time.  It reads
only the volatile queue view and an already-created progress registry; it never
creates a registry, scans history, reads prompt graphs, or queries GPU state.
"""
from __future__ import annotations

import importlib
import math
from collections.abc import Mapping
from typing import Any

_AUTO_PROGRESS_MODULE = object()
_MISSING = object()
_TERMINAL_NODE_STATES = frozenset({"finished", "error"})
_PENDING_NODE_STATES = frozenset({"pending"})
_MAX_ID_LENGTH = 256
_MAX_WORKFLOW_NAME_LENGTH = 120
_MAX_TIMESTAMP_TEXT_LENGTH = 64
_TIMESTAMP_CHARS = frozenset("0123456789TtZz:+-. ")


class ProgressSnapshotUnavailable(RuntimeError):
    """The live queue could not be read for a trustworthy snapshot."""


def snapshot_progress(
    prompt_queue: Any,
    progress_module: Any = _AUTO_PROGRESS_MODULE,
) -> dict[str, Any]:
    """Build a small, read-only snapshot of the live queue progress.

    ``PromptQueue.get_current_queue_volatile`` is the only queue operation used.
    Queue items are never deep-copied because that would traverse prompts and
    arbitrary extra data; only their prompt id and two explicitly allowed
    metadata fields are copied into the response.

    When several workers are visible, the running item matching the registry is
    selected.  Without a matching registry, the first queue item remains the
    active job and its node progress is intentionally omitted.
    """
    running_items, pending_items = _read_volatile_queue(prompt_queue)
    running_jobs = [job for item in running_items if (job := _queue_job(item)) is not None]

    payload: dict[str, Any] = {
        "ok": True,
        "prompt_id": None,
        "nodes": {},
        "active_job": None,
        "pending_count": len(pending_items),
        "running_count": len(running_items),
        "running_ids": [job["id"] for job in running_jobs],
    }
    if not running_jobs:
        return payload

    if progress_module is _AUTO_PROGRESS_MODULE:
        progress_module = _load_progress_module()
    registry = _existing_registry(progress_module)
    registry_prompt_id = _registry_prompt_id(registry)
    matching_job = next((job for job in running_jobs if job["id"] == registry_prompt_id), None)
    active_job = matching_job or running_jobs[0]

    payload["prompt_id"] = active_job["id"]
    payload["active_job"] = {
        "id": active_job["id"],
        "status": "in_progress",
        "workflow_name": active_job["workflow_name"],
        "create_time": active_job["create_time"],
    }

    if matching_job is not None and registry is not None:
        nodes = _snapshot_nodes(registry)
        # A registry may be reset while its mapping is copied.  Do not publish
        # that state after its prompt id no longer belongs to this queue item.
        if _registry_prompt_id(registry) == active_job["id"]:
            payload["nodes"] = nodes

    return payload


def _read_volatile_queue(prompt_queue: Any) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    """Take independent shallow list snapshots without reading queue history."""
    try:
        current = prompt_queue.get_current_queue_volatile()
        if not isinstance(current, (tuple, list)) or len(current) < 2:
            raise TypeError("unexpected volatile queue response")
        return tuple(current[0]), tuple(current[1])
    except Exception as exc:
        raise ProgressSnapshotUnavailable("volatile queue snapshot unavailable") from exc


def _queue_job(item: Any) -> dict[str, Any] | None:
    """Extract only allowed scalar metadata from one normal Comfy queue item."""
    try:
        if not isinstance(item, (tuple, list)) or len(item) < 2:
            return None
        prompt_id = _safe_id(item[1])
        if prompt_id is None:
            return None
        extra_data = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    except (IndexError, TypeError):
        return None

    remote = extra_data.get("mobile_remote")
    remote = remote if isinstance(remote, dict) else {}
    return {
        "id": prompt_id,
        # This is the sole workflow-name source permitted by this endpoint.
        "workflow_name": _safe_workflow_name(remote.get("workflow_name")),
        # ComfyUI places this queue timestamp at top-level extra_data.
        "create_time": _safe_create_time(extra_data.get("create_time")),
    }


def _load_progress_module() -> Any | None:
    """Load the optional progress module only after a queue item is running."""
    try:
        return importlib.import_module("comfy_execution.progress")
    except Exception:
        # Older ComfyUI versions may not provide this registry.  A running job
        # is still reported, with unknown node progress rather than fabricated data.
        return None


def _existing_registry(progress_module: Any) -> Any | None:
    """Read an existing registry without calling get_progress_state()."""
    if progress_module is None:
        return None

    # `_progress_state` supports the earlier plugin-facing shape.  The current
    # upstream module exposes `global_progress_registry`; retain both without
    # mutating either implementation.
    for attribute in ("_progress_state", "global_progress_registry"):
        try:
            candidate = getattr(progress_module, attribute)
        except Exception:
            continue
        if candidate is None:
            continue
        if _registry_field(candidate, "prompt_id", _MISSING) is not _MISSING:
            return candidate
    return None


def _registry_field(registry: Any, name: str, default: Any) -> Any:
    try:
        if isinstance(registry, Mapping):
            return registry.get(name, default)
        return getattr(registry, name)
    except Exception:
        return default


def _registry_prompt_id(registry: Any | None) -> str | None:
    if registry is None:
        return None
    return _safe_id(_registry_field(registry, "prompt_id", None))


def _snapshot_nodes(registry: Any) -> dict[str, dict[str, Any]]:
    """Copy nonterminal, finite node states while tolerating concurrent updates."""
    nodes = _registry_field(registry, "nodes", None)
    if not isinstance(nodes, Mapping):
        return {}
    try:
        entries = list(nodes.items())
    except Exception:
        return {}

    snapshot: dict[str, dict[str, Any]] = {}
    for raw_node_id, raw_entry in entries:
        node_id = _safe_id(raw_node_id)
        if node_id is None or not isinstance(raw_entry, Mapping):
            continue
        try:
            entry = dict(raw_entry)
        except Exception:
            continue

        state = _normalise_state(entry.get("state"))
        value = _finite_number(entry.get("value"))
        max_value = _finite_number(entry.get("max"))
        if state is None or value is None or max_value is None:
            continue

        snapshot[node_id] = {
            "node_id": node_id,
            "display_node_id": _display_node_id(registry, node_id),
            "parent_node_id": _parent_node_id(registry, node_id),
            "value": value,
            "max": max_value,
            "state": state,
        }
    return snapshot


def _normalise_state(value: Any) -> str | None:
    try:
        value = getattr(value, "value", value)
    except Exception:
        return "unknown"
    if not isinstance(value, str):
        return "unknown"

    normalised = value.strip().lower()
    if normalised in _TERMINAL_NODE_STATES or normalised in _PENDING_NODE_STATES:
        return None
    return "running" if normalised == "running" else "unknown"


def _display_node_id(registry: Any, node_id: str) -> str | None:
    dynprompt = _registry_field(registry, "dynprompt", None)
    try:
        getter = getattr(dynprompt, "get_display_node_id")
        return _safe_id(getter(node_id))
    except Exception:
        return None


def _parent_node_id(registry: Any, node_id: str) -> str | None:
    dynprompt = _registry_field(registry, "dynprompt", None)
    try:
        getter = getattr(dynprompt, "get_parent_node_id")
        return _safe_id(getter(node_id))
    except Exception:
        return None


def _finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) else None
    except (OverflowError, TypeError, ValueError):
        return None


def _safe_id(value: Any) -> str | None:
    if isinstance(value, str):
        text = value
    elif isinstance(value, int) and not isinstance(value, bool):
        text = str(value)
    else:
        return None
    if not text or len(text) > _MAX_ID_LENGTH or "\x00" in text:
        return None
    return text


def _safe_workflow_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = "".join(character for character in value if character >= " " and character != "\x7f").strip()
    return text[:_MAX_WORKFLOW_NAME_LENGTH] or None


def _safe_create_time(value: Any) -> int | float | str | None:
    number = _finite_number(value)
    if number is not None:
        return number
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > _MAX_TIMESTAMP_TEXT_LENGTH:
        return None
    return text if all(character in _TIMESTAMP_CHARS for character in text) else None
