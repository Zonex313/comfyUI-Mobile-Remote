"""Build phone-local API/native copies without changing the desktop snapshot."""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

_WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "ENUM"}
_CONTROL = "control_after_generate"
_REROUTES = {"Reroute"}


def _registered_specs(class_type: str) -> dict:
    import nodes

    node_class = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    if node_class is None:
        raise ValueError(f"节点类型未注册：{class_type}")
    raw = node_class.INPUT_TYPES()
    result = {}
    for section in ("required", "optional"):
        for name, entry in raw.get(section, {}).items():
            token = entry[0] if isinstance(entry, (list, tuple)) else entry
            config = entry[1] if isinstance(entry, (list, tuple)) and len(entry) > 1 and isinstance(entry[1], dict) else {}
            kind = "COMBO" if isinstance(token, (list, tuple, set)) else str(getattr(token, "value", token)).upper()
            result[name] = {"type": kind, "config": config, "required": section == "required"}
    return result


def _id(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value):
        raise ValueError("节点或连线编号无效")
    return str(value)


def _overrides(value: Any, name: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"{name}必须是按节点编号组织的对象")
    result = {}
    for key, item in value.items():
        key = _id(key)
        if key in result:
            raise ValueError(f"{name}包含重复节点编号：{key}")
        result[key] = item
    return result


def _ports(node: dict, key: str) -> list:
    ports = node.get(key, [])
    if not isinstance(ports, list) or any(not isinstance(port, dict) for port in ports):
        raise ValueError(f"节点 {node.get('id')} 的 {key} 结构无效")
    return ports


def _widget_slots(node: dict, specs: dict) -> list:
    linked = {port.get("name") for port in _ports(node, "inputs") if port.get("link") is not None}
    slots = []
    for name, spec in specs.items():
        config = spec.get("config") or {}
        if name in linked or config.get("forceInput") or spec.get("type", "").upper() not in _WIDGET_TYPES:
            continue
        slots.append((name, False))
        if config.get(_CONTROL, name in {"seed", "noise_seed"}):
            slots.append((_CONTROL, True))
    return slots


def _widget_mapping(node: dict, raw: Any, specs: dict) -> dict:
    slots = _widget_slots(node, specs)
    if isinstance(raw, list):
        if len(raw) != len(slots):
            raise ValueError(f"节点 {node['id']} 控件数量不匹配：应有 {len(slots)} 项，实际 {len(raw)} 项；不能可靠还原")
        values = raw
    elif isinstance(raw, dict):
        names = [name for name, _ in slots]
        if len(set(names)) != len(names):
            raise ValueError(f"节点 {node['id']} 控件名称重复，无法按名称还原")
        if set(raw) != set(names):
            raise ValueError(f"节点 {node['id']} 控件名称不匹配，存在缺失或未知控件")
        values = [raw[name] for name in names]
    else:
        raise ValueError(f"节点 {node['id']} 控件序列必须是数组或名称对象")
    result = {}
    for (name, frontend_only), value in zip(slots, values):
        # An API input shaped like [node_id, slot] is a link, not a widget value.
        # Only native topology may produce links, including for COMBO inputs.
        if not isinstance(value, (str, int, float, bool)):
            raise ValueError(f"节点 {node['id']} 控件 {name} 必须是普通值，不能传入连线或对象")
        if not frontend_only:
            result[name] = deepcopy(value)
    return result


def apply_named_values_to_native(native: dict, submitted: dict, *, input_specs: Callable | None = None) -> dict:
    """Mirror already-coerced node_id::input values into reliable native widgets.

    This metadata-only operation never invents a mapping for custom serializers.
    Unrelated nodes and ambiguous layouts stay intact; the input is never mutated.
    Frontend-only control slots retain their values while real seed slots update.
    """
    result = deepcopy(native)
    if not isinstance(submitted, dict):
        raise ValueError("已提交参数必须是按输入名称组织的对象")
    if not submitted or not isinstance(result, dict) or not isinstance(result.get("nodes"), list):
        return result
    requested = {}
    for key, value in submitted.items():
        if not isinstance(key, str) or not isinstance(value, (str, int, float, bool)):
            continue
        node_id, separator, name = key.rpartition("::")
        if separator and node_id and name:
            requested.setdefault(node_id, {})[name] = value
    candidates = {}
    for node in result["nodes"]:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id", ""))
        if node_id in requested:
            candidates.setdefault(node_id, []).append(node)
    lookup = input_specs or _registered_specs
    cache = {}
    for node_id, matches in candidates.items():
        if len(matches) != 1:
            continue  # A duplicate root ID cannot identify one trustworthy widget.
        node = matches[0]
        try:
            kind = node.get("type")
            if kind not in cache:
                cache[kind] = lookup(kind)
            specs = cache[kind]
            if not isinstance(specs, dict) or any(not isinstance(spec, dict) for spec in specs.values()):
                continue
            raw = node.get("widgets_values", [])
            mapped = _widget_mapping(node, raw, specs)
            slots = _widget_slots(node, specs)
        except Exception:
            # Metadata must not break execution of a valid desktop-compiled branch.
            continue
        for index, (name, frontend_only) in enumerate(slots):
            if frontend_only or name not in mapped or name not in requested[node_id]:
                continue
            if isinstance(raw, list):
                raw[index] = deepcopy(requested[node_id][name])
            else:
                raw[name] = deepcopy(requested[node_id][name])
    return result


class _NativeGraph:
    def __init__(self, native: dict, nodes: dict):
        self.nodes = nodes
        self.links = {}
        self.outgoing = {}
        for raw in native.get("links", []):
            if isinstance(raw, (list, tuple)) and len(raw) >= 6:
                link_id, source, source_slot, target, target_slot, kind = raw[:6]
            elif isinstance(raw, dict):
                try:
                    link_id, source, source_slot, target, target_slot, kind = (
                        raw["id"], raw["origin_id"], raw["origin_slot"], raw["target_id"], raw["target_slot"], raw.get("type")
                    )
                except KeyError as exc:
                    raise ValueError("原生连线信息不完整") from exc
            else:
                raise ValueError("原生连线格式无效")
            if type(source_slot) is not int or type(target_slot) is not int or min(source_slot, target_slot) < 0:
                raise ValueError("原生连线槽位无效")
            link_id, source, target = _id(link_id), _id(source), _id(target)
            if link_id in self.links:
                raise ValueError(f"原生连线编号重复：{link_id}")
            edge = (source, source_slot, target, target_slot, kind)
            self.links[link_id] = edge
            self.outgoing.setdefault(source, []).append(edge)

    def incoming(self, node_id: str, slot: int) -> tuple:
        ports = _ports(self.nodes[node_id], "inputs")
        if not 0 <= slot < len(ports) or ports[slot].get("link") is None:
            raise ValueError(f"节点 {node_id} 输入 {slot} 缺少来源连线")
        edge = self.links.get(_id(ports[slot]["link"]))
        if edge is None or edge[2:4] != (node_id, slot):
            raise ValueError(f"节点 {node_id} 输入 {slot} 连线来源不一致")
        return edge

    def resolve(self, node_id: str, slot: int, modes: dict, available: dict, seen=None) -> list:
        seen = set() if seen is None else seen
        key = (node_id, slot)
        if key in seen:
            raise ValueError(f"节点 {node_id} 的绕过连线存在循环")
        seen = seen | {key}
        node = self.nodes.get(node_id)
        if node is None:
            if node_id in available:
                return [node_id, slot]  # Existing compiled subgraph IDs are authoritative.
            raise ValueError(f"缺少连线来源节点：{node_id}")
        outputs = _ports(node, "outputs")
        if not 0 <= slot < len(outputs):
            raise ValueError(f"节点 {node_id} 输出槽位 {slot} 不存在")
        reroute = node.get("type") in _REROUTES
        if modes.get(node_id, node.get("mode", 0)) != 4 and not reroute:
            if node_id not in available:
                raise ValueError(f"节点 {node_id} 没有可用的编译结果，不能还原自定义虚拟节点")
            return [node_id, slot]
        inputs = _ports(node, "inputs")
        if reroute:
            if len(inputs) != 1:
                raise ValueError(f"转接节点 {node_id} 输入不唯一")
            input_slot = 0
        else:
            kind = outputs[slot].get("type")
            if kind in (None, "", "*"):
                raise ValueError(f"节点 {node_id} 绕过输出类型不明确")
            matches = [index for index, port in enumerate(inputs) if port.get("type") == kind]
            if slot in matches:
                input_slot = slot
            elif len(matches) == 1:
                input_slot = matches[0]
            else:
                raise ValueError(f"节点 {node_id} 绕过输入类型无法唯一匹配：{kind}")
        edge = self.incoming(node_id, input_slot)
        return self.resolve(edge[0], edge[1], modes, available, seen)

    def affected_inputs(self, changed: set, original_modes: dict, modes: dict) -> set:
        pending = list(changed)
        visited = set()
        result = set()
        while pending:
            source = pending.pop()
            if source in visited:
                continue
            visited.add(source)
            for edge in self.outgoing.get(source, []):
                target, slot = edge[2:4]
                node = self.nodes.get(target)
                if node is None:
                    raise ValueError(f"受修改影响的节点 {target} 不在原生图中，不能推测其输入")
                if original_modes.get(target) == 4 or modes.get(target) == 4 or node.get("type") in _REROUTES:
                    pending.append(target)
                if modes.get(target) != 4 and node.get("type") not in _REROUTES:
                    result.add((target, slot))
        return result


def _reference(value: Any, known: set) -> bool:
    return (isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))
            and not isinstance(value[0], bool) and str(value[0]) in known and type(value[1]) is int and value[1] >= 0)


def _same_reference(left: Any, right: Any) -> bool:
    return isinstance(left, list) and len(left) == 2 and str(left[0]) == str(right[0]) and left[1] == right[1]


def _reject_cycles(prompt: dict) -> None:
    known, done, visiting = set(prompt), set(), set()

    def visit(node_id):
        if node_id in visiting:
            raise ValueError(f"手机工作流存在循环连接：{node_id}")
        if node_id in done:
            return
        visiting.add(node_id)
        for value in prompt[node_id].get("inputs", {}).values():
            if _reference(value, known):
                visit(str(value[0]))
        visiting.remove(node_id)
        done.add(node_id)

    for node_id in prompt:
        visit(node_id)


def prepare_local_prompt(record: dict, node_modes=None, widget_values=None, *, input_specs: Callable | None = None) -> tuple[dict, dict]:
    """Return independent API/native copies, or ValueError for unsafe reconstruction.

    Overrides address existing root nodes only. No topology or node definition
    is accepted from the caller; all connections come from the trusted record.
    """
    if not isinstance(record, dict) or not isinstance(record.get("prompt"), dict):
        raise ValueError("工作流快照缺少 API prompt")
    prompt = deepcopy(record["prompt"])
    native = deepcopy(record.get("workflow", {}))
    mode_edits = _overrides(node_modes, "节点模式")
    widget_edits = _overrides(widget_values, "控件修改")
    if not mode_edits and not widget_edits:
        return prompt, native
    if not isinstance(native, dict) or not isinstance(native.get("nodes"), list):
        raise ValueError("工作流快照缺少原生节点，不能应用手机修改")
    nodes = {}
    for node in native["nodes"]:
        if not isinstance(node, dict) or "id" not in node:
            raise ValueError("原生节点格式无效")
        node_id = _id(node["id"])
        if node_id in nodes:
            raise ValueError(f"原生节点编号重复：{node_id}")
        nodes[node_id] = node
    for node_id in mode_edits.keys() | widget_edits.keys():
        if node_id not in nodes:
            raise ValueError(f"只能修改已有原生节点：{node_id}")
    original_modes = {key: node.get("mode", 0) for key, node in nodes.items()}
    modes = dict(original_modes)
    for node_id, mode in mode_edits.items():
        if type(mode) is not int or mode not in (0, 4):
            raise ValueError(f"节点 {node_id} 模式只能为 0（启用）或 4（绕过）")
        if original_modes[node_id] not in (0, 4):
            raise ValueError(f"节点 {node_id} 的原始模式不支持安全重建")
        modes[node_id] = mode
    changed = {node_id for node_id in mode_edits if modes[node_id] != original_modes[node_id]}
    widget_edits = {key: raw for key, raw in widget_edits.items() if raw != nodes[key].get("widgets_values", [])}
    if not changed and not widget_edits:
        return prompt, native
    lookup = input_specs or _registered_specs
    specs_cache = {}

    def specs_for(node_id):
        kind = nodes[node_id].get("type")
        if kind not in specs_cache:
            try:
                specs = lookup(kind)
            except Exception as exc:
                raise ValueError(f"节点 {node_id} 类型 {kind} 的输入声明不可用") from exc
            # None means unavailable; an empty dict is a registered zero-input node.
            if not isinstance(specs, dict) or any(not isinstance(value, dict) for value in specs.values()):
                raise ValueError(f"节点 {node_id} 类型 {kind} 未注册或缺少输入声明")
            specs_cache[kind] = specs
        return specs_cache[kind]

    widget_changes = {}
    for node_id, raw in widget_edits.items():
        node = nodes[node_id]
        specs = specs_for(node_id)
        before = _widget_mapping(node, node.get("widgets_values", []), specs)
        after = _widget_mapping(node, raw, specs)
        widget_changes[node_id] = {key: value for key, value in after.items() if value != before[key]}
        node["widgets_values"] = deepcopy(raw)
    for node_id in changed:
        nodes[node_id]["mode"] = modes[node_id]

    restored = {node_id for node_id in changed if modes[node_id] == 0 and node_id not in prompt}
    for node_id in restored:
        node = nodes[node_id]
        if node.get("type") in _REROUTES:
            continue
        specs = specs_for(node_id)
        values = _widget_mapping(node, node.get("widgets_values", []), specs)
        prompt[node_id] = {"class_type": node["type"], "inputs": values}
        if node.get("title"):
            prompt[node_id]["_meta"] = {"title": node["title"]}

    if changed:
        graph = _NativeGraph(native, nodes)
        for node_id in restored:
            node = nodes[node_id]
            if node.get("type") in _REROUTES:
                continue
            specs = specs_for(node_id)
            inputs = prompt[node_id]["inputs"]
            for slot, port in enumerate(_ports(node, "inputs")):
                if port.get("link") is None:
                    continue
                name = port.get("name")
                if name not in specs or name in inputs:
                    raise ValueError(f"节点 {node_id} 输入 {name} 无法按声明唯一还原")
                edge = graph.incoming(node_id, slot)
                inputs[name] = graph.resolve(edge[0], edge[1], modes, prompt)
            for name, spec in specs.items():
                if spec.get("required") and name not in inputs:
                    raise ValueError(f"节点 {node_id} 缺少必需输入：{name}")

        for node_id, slot in graph.affected_inputs(changed, original_modes, modes):
            if node_id in restored:
                continue
            if node_id not in prompt:
                raise ValueError(f"受修改影响的节点 {node_id} 没有可编辑的编译结果")
            node = nodes[node_id]
            ports = _ports(node, "inputs")
            if not 0 <= slot < len(ports):
                raise ValueError(f"节点 {node_id} 输入槽位不存在")
            name = ports[slot].get("name")
            inputs = prompt[node_id].get("inputs", {})
            edge = graph.incoming(node_id, slot)
            previous = graph.resolve(edge[0], edge[1], original_modes, record["prompt"])
            if name not in inputs or not _same_reference(inputs[name], previous):
                raise ValueError(f"节点 {node_id} 输入 {name} 有自定义编译行为，不能安全改接")
            inputs[name] = graph.resolve(edge[0], edge[1], modes, prompt)

        removed = {node_id for node_id in changed if modes[node_id] == 4}
        for node_id, compiled in list(prompt.items()):
            if node_id in removed:
                continue
            for name, value in compiled.get("inputs", {}).items():
                if _reference(value, removed):
                    compiled["inputs"][name] = graph.resolve(str(value[0]), value[1], modes, prompt)
        for node_id in removed:
            prompt.pop(node_id, None)

    for node_id, edits in widget_changes.items():
        if modes[node_id] == 4 or node_id in restored:
            continue
        compiled = prompt.get(node_id)
        if not compiled or compiled.get("class_type") != nodes[node_id].get("type"):
            raise ValueError(f"节点 {node_id} 的自定义编译结果不支持控件映射")
        for name, value in edits.items():
            if name not in compiled.get("inputs", {}):
                raise ValueError(f"节点 {node_id} 编译结果缺少控件输入：{name}")
            compiled["inputs"][name] = deepcopy(value)
    if changed:
        _reject_cycles(prompt)
    return prompt, native
