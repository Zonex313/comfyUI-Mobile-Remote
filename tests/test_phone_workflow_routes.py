"""Isolated HTTP tests for phone snapshots and local workflow submission.

Run with ComfyUI's bundled Python (aiohttp required). All persistence is redirected
to TemporaryDirectory before registration; enqueue is captured, never executed.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def source_payload(*, text="desktop original", bypassed=False, source="fixtures/source.json"):
    upstream = "1" if bypassed else "2"
    prompt = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "base.safetensors"}},
        "3": {"class_type": "Sampler", "inputs": {"model": [upstream, 0], "seed": 7, "steps": 20}},
        "4": {"class_type": "TextEncode", "inputs": {"clip": [upstream, 1], "text": text}},
    }
    if not bypassed:
        prompt["2"] = {"class_type": "LoraLoader", "inputs": {
            "model": ["1", 0], "clip": ["1", 1], "lora_name": "style.safetensors",
            "strength_model": 0.75, "strength_clip": 0.5,
        }}
    native = {"version": 0.4, "nodes": [
        {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0, "inputs": [],
         "outputs": [{"name": "MODEL", "type": "MODEL"}, {"name": "CLIP", "type": "CLIP"}],
         "widgets_values": ["base.safetensors"]},
        {"id": 2, "type": "LoraLoader", "mode": 4 if bypassed else 0,
         "inputs": [{"name": "model", "type": "MODEL", "link": 1}, {"name": "clip", "type": "CLIP", "link": 2}],
         "outputs": [{"name": "MODEL", "type": "MODEL"}, {"name": "CLIP", "type": "CLIP"}],
         "widgets_values": ["style.safetensors", 0.75, 0.5]},
        {"id": 3, "type": "Sampler", "mode": 0,
         "inputs": [{"name": "model", "type": "MODEL", "link": 3}], "outputs": [],
         "widgets_values": [7, "fixed", 20]},
        {"id": 4, "type": "TextEncode", "mode": 0,
         "inputs": [{"name": "clip", "type": "CLIP", "link": 4}], "outputs": [], "widgets_values": [text]},
    ], "links": [[1, 1, 0, 2, 0, "MODEL"], [2, 1, 1, 2, 1, "CLIP"],
                 [3, 2, 0, 3, 0, "MODEL"], [4, 2, 1, 4, 0, "CLIP"]], "groups": []}
    return {"name": "Saved source", "source": source, "prompt": prompt, "workflow": native}


def fake_nodes():
    raw_specs = {
        "CheckpointLoaderSimple": {"required": {"ckpt_name": (["base.safetensors"],)}},
        "LoraLoader": {"required": {
            "model": ("MODEL",), "clip": ("CLIP",), "lora_name": (["style.safetensors"],),
            "strength_model": ("FLOAT", {"min": -20, "max": 20}),
            "strength_clip": ("FLOAT", {"min": -20, "max": 20}),
        }},
        "Sampler": {"required": {"model": ("MODEL",), "seed": ("INT", {"min": 0, "max": 99999}),
                                   "steps": ("INT", {"min": 1, "max": 100})}},
        "TextEncode": {"required": {"clip": ("CLIP",), "text": ("STRING", {"multiline": True})}},
    }
    module = ModuleType("nodes")
    module.NODE_CLASS_MAPPINGS = {
        name: SimpleNamespace(INPUT_TYPES=lambda raw=raw: deepcopy(raw)) for name, raw in raw_specs.items()
    }
    return module


class PhoneWorkflowRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="phone-workflow-routes-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package_name = "phone_routes_" + uuid.uuid4().hex
        package = ModuleType(self.package_name)
        package.__path__ = [str(ROOT)]  # Never execute the real ComfyUI node package __init__.
        app = web.Application()
        self.instance = SimpleNamespace(app=app, routes=web.RouteTableDef(), send_sync=lambda *args: None)
        fake_server = ModuleType("server")
        fake_server.PromptServer = SimpleNamespace(instance=self.instance)
        modules = {self.package_name: package, "server": fake_server, "nodes": fake_nodes()}
        progress = ModuleType(self.package_name + ".progress_snapshot")
        progress.ProgressSnapshotUnavailable = RuntimeError
        progress.snapshot_progress = lambda *args: {"ok": True, "is_idle": True}
        settings = ModuleType(self.package_name + ".phone_settings")
        settings.register_phone_settings = lambda *args, **kwargs: None
        connections = ModuleType(self.package_name + ".connections")
        connections.register_connections = lambda *args, **kwargs: None
        modules.update({progress.__name__: progress, settings.__name__: settings, connections.__name__: connections})
        self.modules_patch = patch.dict(sys.modules, modules)
        self.modules_patch.start()
        self.addCleanup(self.modules_patch.stop)
        self.server = load_module(self.package_name + ".server", "server.py")
        self.server.PLUGIN_ROOT = self.root
        for name, relative in {
            "WORKFLOW_ROOT": "workflows", "PHONE_SNAPSHOT_ROOT": ".runtime/phone_snapshots",
            "ACTIVE_WORKFLOW_PATH": ".runtime/active_workflow.json", "OPEN_WORKFLOWS_PATH": ".runtime/open_workflows.json",
            "DESKTOP_COMMANDS_PATH": ".runtime/desktop_commands.json", "DRAFT_ROOT": "drafts",
            "HISTORY_INDEX_PATH": "mobile_history.json", "FAVORITES_PATH": "mobile_favorites.json",
            "FAVORITE_FILES": "favorite_files", "I18N_ROOT": "i18n",
        }.items():
            setattr(self.server, name, self.root / relative)
        self.server._HISTORY_TIMER_STARTED = True
        self.enqueued = []
        self.desktop_tasks = []

        async def capture_enqueue(**payload):
            self.enqueued.append(deepcopy(payload))
            return {"ok": True, "prompt_id": f"captured-{len(self.enqueued)}"}, None

        self.server._enqueue_prompt = capture_enqueue
        self.server.register_routes()
        app.add_routes(self.instance.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.addAsyncCleanup(self.finish_desktop_tasks)

    async def finish_desktop_tasks(self):
        for task in self.desktop_tasks:
            if not task.done():
                task.cancel()
        if self.desktop_tasks:
            await asyncio.gather(*self.desktop_tasks, return_exceptions=True)

    async def request_json(self, method, path, *, status=200, **kwargs):
        async with self.client.request(method, path, **kwargs) as response:
            data = await response.json()
            self.assertEqual(response.status, status, data)
            return data

    async def sync(self, payload):
        response = await self.request_json("POST", "/mobile/api/workflows/sync", json=payload)
        self.assertTrue(response["ok"])
        return response["workflow"]["id"]

    async def detail(self, workflow_id, token=""):
        response = await self.request_json("GET", f"/mobile/api/workflows/{workflow_id}", params={"snapshot": token})
        return response["workflow"]

    async def submit(self, workflow_id, token, **extra):
        return await self.request_json("POST", "/mobile/api/jobs", json={
            "workflow_id": workflow_id, "snapshot": token, "client_id": "isolated-phone", **extra,
        })

    def disk_snapshot(self):
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    async def test_detail_creates_immutable_snapshot_and_old_snapshot_survives_desktop_changes(self):
        original = source_payload()
        workflow_id = await self.sync(original)
        first = await self.detail(workflow_id)
        token = first["snapshot"]
        self.assertRegex(token, r"^[a-f0-9]{64}$")
        snapshot_path = self.server.PHONE_SNAPSHOT_ROOT / workflow_id / (token + ".json")
        stored = snapshot_path.read_bytes()
        self.assertEqual(first["native_workflow"], original["workflow"])
        self.assertEqual(json.loads(stored)["prompt"], original["prompt"])
        self.assertEqual((await self.detail(workflow_id))["snapshot"], token)

        newer = source_payload(text="desktop changed later", bypassed=True)
        self.assertEqual(await self.sync(newer), workflow_id)
        old_detail = await self.detail(workflow_id, token)
        self.assertEqual(old_detail["native_workflow"], original["workflow"])
        self.assertEqual(old_detail["snapshot"], token)
        self.assertNotEqual((await self.detail(workflow_id))["snapshot"], token)
        await self.submit(workflow_id, token, values={"4::text": "phone independent", "3::steps": "31"})
        captured = self.enqueued[-1]
        self.assertEqual(captured["prompt"]["4"]["inputs"]["text"], "phone independent")
        self.assertEqual(captured["prompt"]["3"]["inputs"]["steps"], 31)
        self.assertIn("2", captured["prompt"])
        self.assertEqual(captured["workflow"]["nodes"][3]["widgets_values"], ["phone independent"])
        self.assertEqual(captured["workflow"]["nodes"][2]["widgets_values"], [7, "fixed", 31])
        self.assertEqual(snapshot_path.read_bytes(), stored)
        self.assertEqual(self.server._load_record(workflow_id)["prompt"], newer["prompt"])

    async def test_jobs_bypass_and_restore_lora_on_original_endpoint_without_source_mutation(self):
        workflow_id = await self.sync(source_payload())
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        await self.submit(workflow_id, token, node_modes={"2": 4}, values={"4::text": "local bypass"})
        bypassed = self.enqueued[-1]
        self.assertNotIn("2", bypassed["prompt"])
        self.assertEqual(bypassed["prompt"]["3"]["inputs"]["model"], ["1", 0])
        self.assertEqual(bypassed["prompt"]["4"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(bypassed["workflow"]["nodes"][1]["mode"], 4)
        await self.submit(workflow_id, token, node_modes={"2": 0}, values={"2::strength_model": "0.2"})
        restored = self.enqueued[-1]
        self.assertEqual(restored["prompt"]["3"]["inputs"]["model"], ["2", 0])
        self.assertEqual(restored["prompt"]["4"]["inputs"]["clip"], ["2", 1])
        self.assertEqual(restored["prompt"]["2"]["inputs"]["strength_model"], 0.2)
        self.assertEqual(restored["workflow"]["nodes"][1]["widgets_values"], ["style.safetensors", 0.2, 0.5])
        self.assertEqual(self.disk_snapshot(), before)

    async def test_jobs_enable_originally_bypassed_lora_then_apply_named_values(self):
        workflow_id = await self.sync(source_payload(bypassed=True))
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        await self.submit(workflow_id, token, node_modes={"2": 0}, values={"2::strength_clip": "0.125"})
        captured = self.enqueued[-1]
        self.assertEqual(captured["prompt"]["2"]["inputs"]["model"], ["1", 0])
        self.assertEqual(captured["prompt"]["2"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(captured["prompt"]["2"]["inputs"]["strength_clip"], 0.125)
        self.assertEqual(captured["prompt"]["3"]["inputs"]["model"], ["2", 0])
        self.assertEqual(captured["prompt"]["4"]["inputs"]["clip"], ["2", 1])
        self.assertEqual(captured["workflow"]["nodes"][1]["mode"], 0)
        self.assertEqual(captured["workflow"]["nodes"][1]["widgets_values"][2], 0.125)
        self.assertEqual(self.disk_snapshot(), before)

    async def test_randomized_seed_metadata_matches_actual_enqueued_seed(self):
        workflow_id = await self.sync(source_payload())
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        with patch.object(self.server.random, "randint", return_value=24680):
            await self.submit(workflow_id, token, seed_modes={"3::seed": "randomize"})
        captured = self.enqueued[-1]
        self.assertEqual(captured["prompt"]["3"]["inputs"]["seed"], 24680)
        self.assertEqual(captured["submitted_values"]["3::seed"], 24680)
        self.assertEqual(captured["workflow"]["nodes"][2]["widgets_values"], [24680, "fixed", 20])
        self.assertEqual(self.disk_snapshot(), before)

    async def test_increment_and_decrement_return_next_seed_but_enqueue_current_seed(self):
        workflow_id = await self.sync(source_payload())
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        for mode, current, expected in (("increment", 7, 8), ("decrement", 7, 6),
                                        ("increment", 99999, 99999), ("decrement", 0, 0)):
            with self.subTest(mode=mode, seed=current):
                response = await self.submit(workflow_id, token, values={"3::seed": str(current)},
                                             seed_modes={"3::seed": mode})
                self.assertEqual(response["next_seed_values"], {"3::seed": expected})
                captured = self.enqueued[-1]
                self.assertEqual(captured["prompt"]["3"]["inputs"]["seed"], current)
                self.assertEqual(captured["submitted_values"]["3::seed"], current)
                self.assertEqual(captured["workflow"]["nodes"][2]["widgets_values"], [current, "fixed", 20])
        self.assertEqual(self.disk_snapshot(), before)

    async def test_refresh_timeout_preserves_snapshot_and_releases_pending_slot(self):
        workflow_id = await self.sync(source_payload())
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        events = []
        self.instance.send_sync = lambda event, data: events.append((event, deepcopy(data)))
        real_wait_for = asyncio.wait_for
        timed_out = []

        async def immediate_refresh_timeout(awaitable, timeout):
            if timeout == 12:
                timed_out.append(awaitable)
                awaitable.cancel()
                raise asyncio.TimeoutError
            return await real_wait_for(awaitable, timeout)

        with patch.object(self.server.asyncio, "wait_for", side_effect=immediate_refresh_timeout):
            # Repeating beyond the eight-request cap also proves finally removes
            # the expired request; otherwise later attempts would return 429.
            for _ in range(9):
                body = await self.request_json("POST", f"/mobile/api/workflows/{workflow_id}/refresh", status=409, json={})
                self.assertFalse(body["ok"])
                self.assertIn("手机副本未改变", body["error"])
        self.assertEqual(len(timed_out), 9)
        self.assertTrue(all(future.cancelled() for future in timed_out))
        self.assertEqual(len(events), 9)
        self.assertEqual(self.disk_snapshot(), before)
        self.assertEqual((await self.detail(workflow_id, token))["snapshot"], token)
        self.assertEqual(self.enqueued, [])

    async def test_legacy_command_routes_never_accept_or_drain_queued_old_commands(self):
        workflow_id = await self.sync(source_payload())
        queued = [{"id": "old", "workflow_id": workflow_id, "node_id": "2", "action": "delete"}]
        self.server._DESKTOP_COMMANDS = deepcopy(queued)
        self.server.DESKTOP_COMMANDS_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.server.DESKTOP_COMMANDS_PATH.write_text(json.dumps({"commands": queued}), encoding="utf-8")
        before = self.disk_snapshot()
        body = await self.request_json("POST", "/mobile/api/desktop/commands", status=410, json={
            "workflow_id": workflow_id, "node_id": "2", "input": "strength_model", "value": 99,
        })
        self.assertFalse(body["ok"])
        for _ in range(2):
            body = await self.request_json("GET", "/mobile/api/desktop/commands", params={"workflow_id": workflow_id})
            self.assertEqual(body, {"ok": True, "commands": []})
        ack = await self.request_json("POST", "/mobile/api/desktop/commands/ack", json={"ids": ["old"]})
        self.assertEqual(ack["removed"], 0)
        self.assertEqual(self.server._DESKTOP_COMMANDS, queued)
        self.assertEqual(self.disk_snapshot(), before)
        self.assertEqual(self.enqueued, [])

    async def test_source_refresh_requires_matching_target_and_request_and_freezes_acknowledged_record(self):
        workflow_id = await self.sync(source_payload())
        original_token = (await self.detail(workflow_id))["snapshot"]
        original_bytes = (self.server.PHONE_SNAPSHOT_ROOT / workflow_id / (original_token + ".json")).read_bytes()
        unmatched_sent = asyncio.Event()
        allow_match = asyncio.Event()
        events = []

        async def desktop_reply(data):
            wrong_target = source_payload(text="other tab", source="fixtures/other.json")
            wrong_target["refresh_request_id"] = data["request_id"]
            await self.sync(wrong_target)
            wrong_request = source_payload(text="uncorrelated autosync")
            wrong_request["refresh_request_id"] = "wrong-request-id"
            await self.sync(wrong_request)
            unmatched_sent.set()
            await allow_match.wait()
            acknowledged = source_payload(text="acknowledged desktop source")
            acknowledged["refresh_request_id"] = data["request_id"]
            await self.sync(acknowledged)
            await self.sync(source_payload(text="later desktop edit"))

        def send_sync(event, data):
            events.append((event, deepcopy(data)))
            self.desktop_tasks.append(asyncio.create_task(desktop_reply(data)))

        self.instance.send_sync = send_sync
        refresh_task = asyncio.create_task(self.request_json("POST", f"/mobile/api/workflows/{workflow_id}/refresh", json={}))
        self.desktop_tasks.append(refresh_task)
        await asyncio.wait_for(unmatched_sent.wait(), timeout=5)
        self.assertFalse(refresh_task.done(), "An unrelated autosync must not complete a targeted refresh")
        self.assertEqual(events[0][0], "mtr_refresh_source")
        self.assertEqual(events[0][1]["source"], "fixtures/source.json")
        self.assertTrue(events[0][1]["request_id"])
        allow_match.set()
        response = await asyncio.wait_for(refresh_task, timeout=5)
        await asyncio.gather(*(task for task in self.desktop_tasks if task is not refresh_task))
        self.assertNotEqual(response["snapshot"], original_token)
        refreshed = await self.detail(workflow_id, response["snapshot"])
        self.assertEqual(refreshed["native_workflow"]["nodes"][3]["widgets_values"], ["acknowledged desktop source"])
        self.assertEqual(self.server._load_record(workflow_id)["prompt"]["4"]["inputs"]["text"], "later desktop edit")
        self.assertEqual((self.server.PHONE_SNAPSHOT_ROOT / workflow_id / (original_token + ".json")).read_bytes(), original_bytes)
        self.assertEqual(self.enqueued, [])

    async def test_invalid_or_missing_snapshot_and_bad_mode_preserve_all_files(self):
        workflow_id = await self.sync(source_payload())
        token = (await self.detail(workflow_id))["snapshot"]
        before = self.disk_snapshot()
        for invalid in ("../outside", "z" * 64, "0" * 64):
            with self.subTest(snapshot=invalid):
                await self.request_json("POST", "/mobile/api/jobs", status=409,
                    json={"workflow_id": workflow_id, "snapshot": invalid, "values": {"4::text": "must not run"}})
                await self.request_json("GET", f"/mobile/api/workflows/{workflow_id}",
                    status=404 if invalid == "0" * 64 else 400, params={"snapshot": invalid})
        await self.request_json("POST", "/mobile/api/jobs", status=400,
            json={"workflow_id": workflow_id, "snapshot": token, "node_modes": {"2": 2}})
        await self.request_json("POST", f"/mobile/api/drafts/{workflow_id}", status=409, json={"values": {"4::text": "old autosave"}})
        self.assertEqual(self.disk_snapshot(), before)
        self.assertEqual(self.enqueued, [])


class PhoneDraftSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module_name = "phone_draft_schema_" + uuid.uuid4().hex
        cls.settings = load_module(cls.module_name, "phone_settings.py")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop(cls.module_name, None)

    def test_mobile_draft_metadata_accepts_bounded_source_and_local_edit_state(self):
        draft = {"4::text": "phone prompt", "3::seed": 42, "__mobile": {
            "snapshot": "a" * 64, "node_modes": {"2": 4},
            "widget_values": {"2": ["style.safetensors", 0.2, 0.5]},
            "seed_modes": {"3::seed": "randomize"}, "manual_prompt": True,
            "view": {"2": {"hidden": True, "title": "Phone label", "pos": [100, 200]}},
        }}
        original = deepcopy(draft)
        self.settings._validate_draft(draft)
        self.assertEqual(draft, original)

    def test_mobile_draft_rejects_invalid_schema_modes_and_unsafe_nested_values(self):
        cases = [
            {"unknown": 1}, {"snapshot": "not-a-token"}, {"node_modes": []},
            {"node_modes": {"2": 2}}, {"node_modes": {"2": True}},
            {"seed_modes": {"3::seed": "invalid"}}, {"manual_prompt": "true"},
            {"widget_values": {"2": [float("nan")]}},
            {"view": {"node": {"access_token": "secret"}}},
            {"view": {"__proto__": {}}},
        ]
        deeply_nested = "value"
        for _ in range(15):
            deeply_nested = [deeply_nested]
        cases.append({"widget_values": {"2": deeply_nested}})
        for meta in cases:
            with self.subTest(meta=meta), self.assertRaises(self.settings.SettingsError):
                self.settings._validate_draft({"__mobile": meta})
        with self.assertRaises(self.settings.SettingsError):
            self.settings._validate_draft({"4::text": ["not", "scalar"]})


if __name__ == "__main__":
    unittest.main()
