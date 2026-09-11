"""Isolated phone settings tests: no plugin/GPU imports or live server/files.

Run: python.exe -B tests/test_phone_settings.py
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from aiohttp import web

sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).resolve().parents[1] / "phone_settings.py"
SPEC = importlib.util.spec_from_file_location("mobile_phone_settings_under_test", MODULE_PATH)
settings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(settings)

PREFIX = settings.PREFIX
WORKFLOW_ID = "0123456789abcdefabcd"
DRAFT_KEY = settings.DRAFT_PREFIX + WORKFLOW_ID
WORKFLOW_KEY = PREFIX + "workflow"
PRESET_KEY = PREFIX + "preset"
CATALOG_KEY = PREFIX + "presetCatalog"
RANDOM_KEY = PREFIX + "randomGenerate"
REPEAT_KEY = PREFIX + "repeatCount"
COLS_KEY = PREFIX + "historyCols"
FAVORITES_KEY = PREFIX + "favoritesOnly"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def preset():
    return {"enabled": True,
            "slots": {"person.origin": {"value": "\u6d4b\u8bd5", "locked": False, "ignored": True}},
            "custom": {"person.origin": ["tag one", "tag two"]},
            "freeText": "original\nprompt", "extraText": "extra"}


class Clock:
    def __init__(self, milliseconds=1_700_000_000_000):
        self.milliseconds = milliseconds

    def __call__(self):
        return self.milliseconds / 1000

    def advance(self, milliseconds):
        self.milliseconds += milliseconds


class StoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="phone-settings-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.clock = Clock()
        self.store = settings.PhoneSettingsStore(self.root, clock=self.clock)

    def error(self, status, function, *args, **kwargs):
        with self.assertRaises(settings.SettingsError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status, status)
        self.assertIs(caught.exception.payload["ok"], False)
        return caught.exception.payload

    def save(self, changes, revision=None):
        if revision is None:
            revision = self.store.snapshot()["revision"]
        return self.store.save(revision, changes)

    def write_record(self, path, revision=1, saved_at=None, values=None):
        if saved_at is None:
            saved_at = self.clock.milliseconds
        data = {"schema": 1, "revision": revision, "saved_at": saved_at, "values": values or {}}
        path.write_text(json_text(data), encoding="utf-8")
        return path.read_bytes()

    def write_draft(self, workflow_id=WORKFLOW_ID, values=None, raw=None):
        directory = self.root / "drafts"
        directory.mkdir(exist_ok=True)
        path = directory / (workflow_id + ".json")
        path.write_text(raw if raw is not None else json_text({"schema": 1, "saved_at": 1,
                                                              "values": values or {}}),
                        encoding="utf-8")
        return path

    def test_new_store_is_lazy_empty_and_does_not_create_root(self):
        root = self.root / "not-created"
        with mock.patch.object(settings.PhoneSettingsStore, "_read_bytes",
                               side_effect=AssertionError("eager read")):
            store = settings.PhoneSettingsStore(root, clock=self.clock)
        self.assertEqual(store.snapshot(), {"ok": True, "revision": 0, "saved_at": 0,
                                           "exists": False, "retry_after_ms": 0, "values": {}})
        self.assertFalse(root.exists())
        self.assertEqual(store.save(0, {}), store.snapshot())
        self.assertFalse(root.exists())

    def test_first_save_round_trips_exact_local_storage_strings(self):
        changes = {WORKFLOW_KEY: WORKFLOW_ID, PRESET_KEY: json.dumps(preset(), indent=2),
                   DRAFT_KEY: '{"7::text":"hello", "8::seed":42,"9::flag":true,"9::none":null}',
                   RANDOM_KEY: "1", REPEAT_KEY: "10", FAVORITES_KEY: "0", COLS_KEY: "4"}
        snapshot = self.save(changes)
        self.assertEqual(snapshot, {"ok": True, "revision": 1, "saved_at": self.clock.milliseconds,
                                    "exists": True, "retry_after_ms": 60_000, "values": changes})
        saved = json.loads(self.store.path.read_bytes())
        self.assertEqual(saved["schema"], 1)
        self.assertEqual(saved["values"], changes)
        self.assertFalse(self.store.backup_path.exists())
        self.assertEqual(settings.PhoneSettingsStore(self.root, clock=self.clock).snapshot(), snapshot)

    def test_all_preference_enums_and_empty_workflow(self):
        for key, values in settings.PREFERENCES.items():
            for value in sorted(values):
                with self.subTest(key=key, value=value):
                    self.clock.advance(60_000)
                    self.assertEqual(self.save({key: value})["values"][key], value)
        self.clock.advance(60_000)
        self.assertEqual(self.save({WORKFLOW_KEY: ""})["values"][WORKFLOW_KEY], "")

    def test_multi_model_preferences_and_queue(self):
        models = json.dumps({WORKFLOW_ID: ["alpha.safetensors", "beta.safetensors"]})
        self.clock.advance(60_000)
        snapshot = self.save({
            PREFIX + "multiModel": "1",
            PREFIX + "fixedSeed": "1",
            PREFIX + "multiModels": models,
        })
        self.assertEqual(snapshot["values"][PREFIX + "multiModel"], "1")
        self.assertEqual(json.loads(snapshot["values"][PREFIX + "multiModels"])[WORKFLOW_ID][1], "beta.safetensors")
        self.clock.advance(60_000)
        self.error(400, self.store.save, snapshot["revision"], {PREFIX + "multiModels": json.dumps({WORKFLOW_ID: ["x"] * 21})})

    def test_global_rate_limit_and_exact_60_second_boundary(self):
        self.save({RANDOM_KEY: "0"})
        for elapsed, expected in ((0, 60_000), (59_000, 1000), (999, 1)):
            self.clock.advance(elapsed)
            payload = self.error(429, self.store.save, 1, {COLS_KEY: "3"})
            self.assertEqual(payload["retry_after_ms"], expected)
            self.assertEqual(payload["values"], {RANDOM_KEY: "0"})
            self.assertEqual(payload["revision"], 1)
        self.clock.advance(1)
        self.assertEqual(self.save({COLS_KEY: "3"})["revision"], 2)

    def test_persisted_timestamp_enforces_cooldown_after_restart(self):
        self.save({COLS_KEY: "2"})
        self.clock.advance(30_000)
        restarted = settings.PhoneSettingsStore(self.root, clock=self.clock)
        self.assertEqual(restarted.snapshot()["retry_after_ms"], 30_000)
        self.error(429, restarted.save, 1, {COLS_KEY: "4"})
        self.clock.advance(30_000)
        self.assertEqual(restarted.save(1, {COLS_KEY: "4"})["revision"], 2)

    def test_epoch_zero_and_clock_rollback_do_not_bypass_cooldown(self):
        self.clock.milliseconds = 0
        self.save({RANDOM_KEY: "0"})
        self.assertEqual(self.store.snapshot()["retry_after_ms"], 60_000)
        self.error(429, self.store.save, 1, {RANDOM_KEY: "1"})
        self.clock.milliseconds = 60_000
        self.save({RANDOM_KEY: "1"})
        self.clock.advance(-10_000)
        self.assertEqual(self.store.snapshot()["retry_after_ms"], 70_000)

    def test_noop_skips_disk_revision_and_cooldown_consumption(self):
        first = self.save({COLS_KEY: "2"})
        original = self.store.path.read_bytes()
        self.clock.advance(10_000)
        with mock.patch.object(self.store, "_commit", side_effect=AssertionError("no-op wrote disk")):
            for changes in ({COLS_KEY: "2"}, {}, {REPEAT_KEY: None}):
                current = self.save(changes)
                self.assertEqual(current["revision"], first["revision"])
                self.assertEqual(current["saved_at"], first["saved_at"])
                self.assertEqual(current["retry_after_ms"], 50_000)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.clock.advance(50_000)
        self.assertEqual(self.save({COLS_KEY: "3"})["revision"], 2)

    def test_cas_precedes_noop_cooldown_and_mutation(self):
        first = self.save({COLS_KEY: "2"})
        for changes in ({COLS_KEY: "2"}, {RANDOM_KEY: "1"}, {}):
            payload = self.error(409, self.store.save, 0, changes)
            self.assertIs(payload["conflict"], True)
            self.assertEqual(payload["values"], first["values"])
            self.assertEqual(payload["revision"], 1)
            self.assertEqual(payload["retry_after_ms"], 60_000)
        self.assertEqual(self.store.snapshot(), first)

    def test_concurrent_writers_with_same_revision_cannot_lose_update(self):
        barrier = threading.Barrier(2)

        def writer(key, value):
            barrier.wait(timeout=5)
            try:
                return 200, self.store.save(0, {key: value})
            except settings.SettingsError as exc:
                return exc.status, exc.payload

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(writer, RANDOM_KEY, "1"), pool.submit(writer, COLS_KEY, "3")]
            results = [future.result(timeout=5) for future in futures]
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        winner = next(body for status, body in results if status == 200)
        loser = next(body for status, body in results if status == 409)
        self.assertEqual(winner["values"], loser["values"])
        self.assertEqual(self.store.snapshot()["values"], winner["values"])
        self.assertEqual(len(winner["values"]), 1)

    def test_delete_is_atomic_and_invalid_patch_never_partially_applies(self):
        self.save({COLS_KEY: "2", RANDOM_KEY: "1"})
        self.clock.advance(60_000)
        self.error(400, self.store.save, 1, {COLS_KEY: None, RANDOM_KEY: "invalid"})
        self.assertEqual(self.store.snapshot()["values"], {COLS_KEY: "2", RANDOM_KEY: "1"})
        saved = self.save({COLS_KEY: None, RANDOM_KEY: "0"})
        self.assertEqual(saved["values"], {RANDOM_KEY: "0"})
        self.assertEqual(saved["revision"], 2)

    def test_cached_gets_never_reread_or_expose_mutable_values(self):
        self.save({COLS_KEY: "2"})
        cached = settings.PhoneSettingsStore(self.root, clock=self.clock)
        with mock.patch.object(cached, "_read_bytes", wraps=cached._read_bytes) as read:
            first = cached.snapshot()
            first["values"][COLS_KEY] = "4"
            self.store.path.write_text("changed externally", encoding="utf-8")
            for _ in range(20):
                self.assertEqual(cached.snapshot()["values"], {COLS_KEY: "2"})
            self.assertEqual(read.call_count, 1)

    def test_concurrent_first_load_runs_only_once(self):
        self.write_record(self.store.path, values={COLS_KEY: "2"})
        with mock.patch.object(self.store, "_read_bytes", wraps=self.store._read_bytes) as read:
            with ThreadPoolExecutor(max_workers=8) as pool:
                snapshots = list(pool.map(lambda _: self.store.snapshot(), range(40)))
        self.assertEqual(read.call_count, 1)
        self.assertTrue(all(item == snapshots[0] for item in snapshots))

    def test_migration_reads_legacy_once_without_creating_settings_file(self):
        values = {"7::text": "\u4e2d\u6587", "8::seed": 42, "9::flag": True, "9::none": None}
        source = self.write_draft(values=values)
        original = source.read_bytes()
        first = self.store.snapshot()
        self.assertFalse(first["exists"])
        self.assertEqual(first["revision"], 0)
        self.assertEqual(first["saved_at"], 0)
        self.assertEqual(json.loads(first["values"][DRAFT_KEY]), values)
        self.assertFalse(self.store.path.exists())
        self.assertFalse(self.store.backup_path.exists())
        self.assertEqual(source.read_bytes(), original)
        self.write_draft("f" * 20, {"1::text": "late draft"})
        self.assertEqual(self.store.snapshot(), first)
        with mock.patch.object(self.store, "_commit", side_effect=AssertionError("no-op migrated write")):
            self.assertEqual(self.store.save(0, first["values"]), first)
        saved = self.save({COLS_KEY: "3"})
        self.assertTrue(saved["exists"])
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["values"][DRAFT_KEY], first["values"][DRAFT_KEY])
        self.assertEqual(source.read_bytes(), original)

    def test_migration_skips_bad_filenames_corruption_and_non_scalar_values(self):
        self.write_draft("a" * 20, {"1::text": "valid"})
        self.write_draft("A" * 20, {"1::text": "uppercase"})
        self.write_draft("b" * 20, raw="{not json")
        self.write_draft("c" * 20, {"1::text": {"nested": "graph"}})
        self.write_draft("d" * 20, {"1::api_key": "sensitive"})
        self.write_draft("short", {"1::text": "bad id"})
        self.assertEqual(set(self.store.snapshot()["values"]), {settings.DRAFT_PREFIX + "a" * 20})
        self.assertFalse(self.store.path.exists())

    def test_shared_file_prevents_legacy_migration(self):
        self.write_record(self.store.path, values={COLS_KEY: "4"})
        self.write_draft(values={"1::text": "ignored"})
        with mock.patch.object(self.store, "_migrate", side_effect=AssertionError("unexpected migration")):
            self.assertEqual(self.store.snapshot()["values"], {COLS_KEY: "4"})

    def test_migration_caps_workflow_drafts_at_250(self):
        for i in range(252):
            self.write_draft(f"{i:020x}", {"1::seed": i})
        self.assertEqual(len(self.store.snapshot()["values"]), 250)
        self.assertFalse(self.store.path.exists())

    def test_backup_is_exact_previous_successful_file(self):
        self.save({COLS_KEY: "2"})
        first = self.store.path.read_bytes()
        self.clock.advance(60_000)
        self.save({COLS_KEY: "3"})
        second = self.store.path.read_bytes()
        self.assertEqual(self.store.backup_path.read_bytes(), first)
        self.clock.advance(60_000)
        self.save({COLS_KEY: "4"})
        self.assertEqual(self.store.backup_path.read_bytes(), second)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_corrupt_primary_recovers_backup_and_preserves_it_on_next_save(self):
        self.store.path.write_bytes(b"broken primary")
        backup = self.write_record(self.store.backup_path, revision=7, values={COLS_KEY: "3"})
        first = self.store.snapshot()
        self.assertEqual(first["values"], {COLS_KEY: "3"})
        self.assertEqual(first["revision"], 7)
        self.assertEqual(first["retry_after_ms"], 60_000)
        self.assertEqual(self.store.path.read_bytes(), b"broken primary")
        self.error(429, self.store.save, 7, {COLS_KEY: "4"})
        self.clock.advance(60_000)
        saved = self.store.save(7, {COLS_KEY: "4"})
        self.assertEqual(saved["revision"], 8)
        self.assertEqual(self.store.backup_path.read_bytes(), backup)
        self.assertEqual(json.loads(self.store.path.read_bytes())["revision"], 8)

    def test_missing_primary_can_recover_existing_backup(self):
        self.write_record(self.store.backup_path, revision=4, values={COLS_KEY: "2"})
        snapshot = self.store.snapshot()
        self.assertTrue(snapshot["exists"])
        self.assertEqual(snapshot["revision"], 4)
        self.assertFalse(self.store.path.exists())

    def test_corrupt_files_return_503_cached_and_are_never_overwritten(self):
        for backup in (False, True):
            with self.subTest(backup=backup):
                store = settings.PhoneSettingsStore(self.root, clock=self.clock)
                store.path.write_bytes(b"{broken")
                if backup:
                    store.backup_path.write_bytes(b"[]")
                self.write_draft(values={"1::text": "must not migrate"})
                with mock.patch.object(store, "_read_bytes", wraps=store._read_bytes) as read:
                    self.error(503, store.snapshot)
                    self.error(503, store.snapshot)
                    self.error(503, store.save, 0, {COLS_KEY: "2"})
                    self.assertEqual(read.call_count, 2)
                self.assertEqual(store.path.read_bytes(), b"{broken")
                if backup:
                    self.assertEqual(store.backup_path.read_bytes(), b"[]")

    def test_bad_persisted_schema_and_values_are_treated_as_corruption(self):
        cases = [[], {}, {"schema": True, "revision": 1, "saved_at": 0, "values": {}},
                 {"schema": 1, "revision": True, "saved_at": 0, "values": {}},
                 {"schema": 1, "revision": 1, "saved_at": -1, "values": {}},
                 {"schema": 1, "revision": 1, "saved_at": 0, "values": {COLS_KEY: "99"}},
                 {"schema": 1, "revision": 1, "saved_at": 0, "values": {}, "graph": {}},
                 {"schema": 1, "revision": 1, "saved_at": 0, "values": {DRAFT_KEY: '{"x":NaN}'}}]
        for data in cases:
            with self.subTest(data=data):
                self.store.path.write_text(json_text(data), encoding="utf-8")
                self.error(503, settings.PhoneSettingsStore(self.root, clock=self.clock).snapshot)

    def test_load_permission_error_does_not_create_fresh_state(self):
        with mock.patch.object(self.store, "_read_bytes", side_effect=PermissionError("fixture")):
            self.error(503, self.store.snapshot)
        self.error(503, self.store.save, 0, {COLS_KEY: "2"})
        self.assertFalse(self.store.path.exists())

    def test_primary_replace_failure_preserves_memory_file_and_retry_eligibility(self):
        self.save({COLS_KEY: "2"})
        primary = self.store.path.read_bytes()
        self.clock.advance(60_000)
        before = self.store.snapshot()
        replace = os.replace

        def fail_primary(source, destination):
            if Path(destination) == self.store.path:
                raise OSError("injected primary replacement failure")
            return replace(source, destination)

        with mock.patch.object(settings.os, "replace", side_effect=fail_primary):
            failure = self.error(503, self.store.save, 1, {COLS_KEY: "3"})
        self.assertEqual(failure["values"], before["values"])
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(self.store.path.read_bytes(), primary)
        self.assertEqual(self.store.backup_path.read_bytes(), primary)
        self.assertEqual(list(self.root.glob("*.tmp")), [])
        self.assertEqual(self.store.save(1, {COLS_KEY: "3"})["revision"], 2)

    def test_backup_replace_failure_preserves_primary_and_existing_backup(self):
        self.save({COLS_KEY: "2"})
        self.clock.advance(60_000)
        self.save({COLS_KEY: "3"})
        self.clock.advance(60_000)
        primary, backup = self.store.path.read_bytes(), self.store.backup_path.read_bytes()
        snapshot = self.store.snapshot()
        replace = os.replace

        def fail_backup(source, destination):
            if Path(destination) == self.store.backup_path:
                raise PermissionError("injected backup replacement failure")
            return replace(source, destination)

        with mock.patch.object(settings.os, "replace", side_effect=fail_backup):
            self.error(503, self.store.save, 2, {COLS_KEY: "4"})
        self.assertEqual(self.store.path.read_bytes(), primary)
        self.assertEqual(self.store.backup_path.read_bytes(), backup)
        self.assertEqual(self.store.snapshot(), snapshot)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_staging_fsync_failure_preserves_all_committed_state(self):
        self.save({COLS_KEY: "2"})
        original = self.store.path.read_bytes()
        self.clock.advance(60_000)
        snapshot = self.store.snapshot()
        with mock.patch.object(settings.os, "fsync", side_effect=OSError("disk full")):
            self.error(503, self.store.save, 1, {COLS_KEY: "3"})
        self.assertEqual(self.store.snapshot(), snapshot)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertFalse(self.store.backup_path.exists())
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_first_write_failure_preserves_initial_state_and_creates_no_settings(self):
        with mock.patch.object(settings.os, "replace", side_effect=OSError("read only")):
            self.error(503, self.store.save, 0, {COLS_KEY: "2"})
        self.assertEqual(self.store.snapshot()["revision"], 0)
        self.assertFalse(self.store.snapshot()["exists"])
        self.assertFalse(self.store.path.exists())
        self.assertFalse(self.store.backup_path.exists())
        self.assertEqual(list(self.root.glob("*.tmp")), [])
        self.assertEqual(self.store.save(0, {COLS_KEY: "2"})["revision"], 1)

    def test_unknown_keys_non_string_values_and_invalid_enums_are_rejected(self):
        cases = [{"arbitrary": "x"}, {PREFIX + "api_key": "secret"}, {"workflow": "x"},
                 {PREFIX + "draft." + "A" * 20: "{}"},
                 {PREFIX + "draft." + "a" * 19: "{}"}, {DRAFT_KEY + "/../x": "{}"},
                 {WORKFLOW_KEY: "../workflow"}, {WORKFLOW_KEY: WORKFLOW_ID + "\n"},
                 {RANDOM_KEY: "true"}, {FAVORITES_KEY: "false"}, {COLS_KEY: "1"},
                 {REPEAT_KEY: "0"}, {REPEAT_KEY: "11"}, {REPEAT_KEY: "1.0"},
                 {REPEAT_KEY: "01"}, {REPEAT_KEY: 1}, {DRAFT_KEY: {}}, {PRESET_KEY: True}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.error(400, self.store.save, 0, changes)
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.store.snapshot()["values"], {})

    def test_base_revision_must_be_nonnegative_safe_integer(self):
        for value in (None, True, False, -1, 0.0, "0", [], 2**53, math.inf):
            with self.subTest(value=value):
                self.error(400, self.store.save, value, {})
        for value in (None, [], "{}", True):
            with self.subTest(changes=value):
                self.error(400, self.store.save, 0, value)

    def test_presets_reject_unbounded_or_wrong_shapes(self):
        cases = [[], {}, {"enabled": 1}, {"enabled": False, "graph": {}},
                 {"enabled": False, "slots": []}, {"enabled": False, "custom": []},
                 {"enabled": False, "freeText": {}},
                 {"enabled": False, "slots": {"x": {"value": "ok", "locked": 1, "ignored": False}}},
                 {"enabled": False, "slots": {"x": {"value": "ok", "locked": False}}},
                 {"enabled": False, "slots": {"x": {"value": {}, "locked": False, "ignored": False}}},
                 {"enabled": False, "custom": {"x": [["nested"]]}},
                 {"enabled": False, "custom": {"x": [" tag "]}},
                 {"enabled": False, "custom": {"constructor": []}}]
        for value in cases:
            with self.subTest(value=value):
                self.error(400, self.store.save, 0, {PRESET_KEY: json_text(value)})
        too_long = preset()
        too_long["extraText"] = "x" * (settings.MAX_TEXT_BYTES + 1)
        self.error(413, self.store.save, 0, {PRESET_KEY: json_text(too_long)})
        self.error(413, self.store.save, 0,
                   {PRESET_KEY: json_text({"enabled": True, "custom": {"a": ["tag"] * 257}})})
        too_many_slots = {str(i): {"value": "x", "locked": False, "ignored": False} for i in range(257)}
        self.error(413, self.store.save, 0,
                   {PRESET_KEY: json_text({"enabled": True, "slots": too_many_slots})})

    def test_preset_catalog_overlay_round_trips_and_rejects_invalid_shapes(self):
        value = preset()
        value["catalog"] = {
            "removed": {"hair.style": ["一侧剃青"]},
            "skipped": {"expression.face": ["放电"]},
            "mutex": [["新标签", "高冷"]],
            "singletons": ["只披外套"],
            "skipCategories": [{"whenAny": ["只披外套"], "skip": ["top", "bra"]}],
        }
        saved = self.save({PRESET_KEY: json_text(value)})
        loaded = json.loads(saved["values"][PRESET_KEY])
        self.assertEqual(loaded["catalog"]["removed"]["hair.style"], ["一侧剃青"])
        self.assertEqual(loaded["catalog"]["mutex"][0][0], "新标签")
        cases = [
            {"enabled": True, "catalog": []},
            {"enabled": True, "catalog": {"unknown": {}}},
            {"enabled": True, "catalog": {"removed": {"hair.style": "tag"}}},
            {"enabled": True, "catalog": {"removed": {"constructor": ["x"]}}},
            {"enabled": True, "catalog": {"skipped": {"hair.style": ["", "x"]}}},
            {"enabled": True, "catalog": {"mutex": [["only-one"]]}},
            {"enabled": True, "catalog": {"mutex": [["a", "a"]]}},
            {"enabled": True, "catalog": {"skipCategories": [{"skip": ["top"]}]}},
            {"enabled": True, "catalog": {"skipCategories": [{"whenAny": ["x"], "skip": []}]}},
            {"enabled": True, "catalog": {"skipCategories": [{"whenTag": "x", "skip": ["top"]}]}},
            {"enabled": True, "catalog": {"custom": {"person.origin": [" tag "]}}},
        ]
        for item in cases:
            with self.subTest(item=item):
                self.error(400, self.store.save, saved["revision"], {PRESET_KEY: json_text(item)})

    def test_preset_catalog_key_is_strict_and_supports_removed_custom(self):
        catalog = {"custom": {"person.origin": ["custom tag"]}, "removed": {},
                   "removedCustom": {"person.origin": ["old custom"]}, "skipped": {},
                   "mutex": [["custom tag", "other"]], "singletons": ["singleton"],
                   "skipCategories": [{"whenAny": ["singleton"], "skip": ["top"]}]}
        saved = self.save({CATALOG_KEY: json_text(catalog)})
        self.assertEqual(json.loads(saved["values"][CATALOG_KEY]), catalog)
        self.clock.advance(60_000)
        invalid = [
            {**catalog, "custom": {"person.origin": [" tag"]}},
            {**catalog, "removedCustom": {"person.origin": ["x", "x"]}},
            {**catalog, "skipCategories": [{"whenTag": "x", "skip": ["top"]}]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.error(400, self.store.save, saved["revision"], {CATALOG_KEY: json_text(value)})
        self.assertEqual(self.store.snapshot()["values"][CATALOG_KEY], json_text(catalog))

    def test_loading_legacy_duplicate_empty_custom_normalizes_without_new_key(self):
        value = preset()
        value["custom"]["person.origin"] = ["", " tag ", "tag", "other"]
        value["catalog"] = {"custom": {"person.origin": ["", "catalog", "catalog"]}}
        original = self.write_record(self.store.path, values={PRESET_KEY: json_text(value)})
        snapshot = self.store.snapshot()
        loaded = json.loads(snapshot["values"][PRESET_KEY])
        self.assertEqual(loaded["custom"]["person.origin"], ["tag", "other"])
        self.assertEqual(loaded["catalog"]["custom"]["person.origin"], ["catalog"])
        self.assertNotIn(CATALOG_KEY, snapshot["values"])
        self.assertEqual(self.store.path.read_bytes(), original)

    def test_loading_legacy_removed_and_when_tag_normalizes_without_new_key(self):
        value = preset()
        value["catalog"] = {
            "removed": {"hair.style": ["", " 一侧剃青 ", "一侧剃青"]},
            "skipped": {"expression.face": ["", "放电"]},
            "mutex": [["新标签", " 新标签 "], ["高冷", "新标签"]],
            "skipCategories": [
                {"whenTag": "只披外套", "skip": ["top", " top "]},
                {"whenAny": ["只披外套"], "skip": ["top"]},
            ],
        }
        original = self.write_record(self.store.path, values={PRESET_KEY: json_text(value)})
        snapshot = self.store.snapshot()
        loaded = json.loads(snapshot["values"][PRESET_KEY])
        self.assertEqual(loaded["catalog"]["removed"]["hair.style"], ["一侧剃青"])
        self.assertEqual(loaded["catalog"]["skipped"]["expression.face"], ["放电"])
        self.assertEqual(loaded["catalog"]["mutex"], [["高冷", "新标签"]])
        self.assertEqual(loaded["catalog"]["skipCategories"],
                         [{"whenAny": ["只披外套"], "skip": ["top"]}])
        self.assertNotIn(CATALOG_KEY, snapshot["values"])
        self.assertEqual(self.store.path.read_bytes(), original)

    def test_normal_scalar_field_names_remain_compatible_with_existing_workflows(self):
        draft = {"7::code": "ordinary text", "8::command": "a prompt describing a command",
                 "9::workflow": "label", "10::text": "line one\nline two",
                 "11::seed": 2**64 - 1, "12::cfg": 7.5, "13::flag": False, "14::empty": None}
        saved = self.save({DRAFT_KEY: json_text(draft)})
        self.assertEqual(json.loads(saved["values"][DRAFT_KEY]), draft)

    def test_drafts_reject_graph_nesting_secrets_and_nonfinite_numbers(self):
        cases = [[], {"x": []}, {"x": {}}, {"x": {"class_type": "node"}},
                 {"1::api_key": "x"}, {"1::authorization": "x"},
                 {"__proto__": "x"}, {"1::_internal": "x"}, {"x": math.inf},
                 {"x": -math.inf}, {"x": math.nan}, {"x": 10**400}, {"": 1}]
        for value in cases:
            with self.subTest(value=value):
                self.error(400, self.store.save, 0, {DRAFT_KEY: json_text(value)})
        self.error(400, self.store.save, 0, {DRAFT_KEY: '{"x":1e999}'})
        self.error(400, self.store.save, 0, {DRAFT_KEY: '{"x":1,"x":2}'})
        self.error(400, self.store.save, 0, {DRAFT_KEY: "[" * 1200 + "0" + "]" * 1200})
        self.error(413, self.store.save, 0,
                   {DRAFT_KEY: json_text({"x": "x" * (settings.MAX_TEXT_BYTES + 1)})})
        self.error(413, self.store.save, 0,
                   {DRAFT_KEY: json_text({str(i): i for i in range(settings.MAX_DRAFT_FIELDS + 1)})})

    def test_request_and_aggregate_size_limits_count_utf8_bytes(self):
        self.error(413, self.store.save_json, b" " * (settings.MAX_BYTES + 1))
        multibyte = json_text({"x": "\u6d4b" * (settings.MAX_TEXT_BYTES // 3 + 1)})
        self.error(413, self.store.save, 0, {DRAFT_KEY: multibyte})
        large_draft = json_text({str(i): "x" * 120_000 for i in range(5)})
        first_batch = {settings.DRAFT_PREFIX + f"{i:020x}": large_draft for i in range(3)}
        self.save(first_batch)
        original = self.store.path.read_bytes()
        self.clock.advance(60_000)
        self.error(413, self.store.save, 1, {settings.DRAFT_PREFIX + "f" * 20: large_draft})
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(self.store.snapshot()["values"], first_batch)

    def test_total_key_and_workflow_draft_caps(self):
        maximum = {settings.DRAFT_PREFIX + f"{i:020x}": "{}" for i in range(250)}
        self.save(maximum)
        self.clock.advance(60_000)
        self.error(413, self.store.save, 1, {settings.DRAFT_PREFIX + "f" * 20: "{}"})
        self.assertEqual(len(self.store.snapshot()["values"]), 250)
        too_many = {settings.DRAFT_PREFIX + f"{i:020x}": None for i in range(261)}
        self.error(413, self.store.save, 1, too_many)


class BodyStream:
    def __init__(self, data, chunk_size=65536):
        self.data = data
        self.chunk_size = chunk_size
        self.started = False

    async def iter_chunked(self, limit):
        self.started = True
        size = min(self.chunk_size, limit)
        for offset in range(0, len(self.data), size):
            yield self.data[offset:offset + size]


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="phone-settings-routes-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.clock = Clock()
        self.server = SimpleNamespace(routes=web.RouteTableDef())
        self.store = settings.register_phone_settings(self.server, root=self.root, clock=self.clock)
        self.handlers = {route.method: route.handler for route in self.server.routes}

    async def post(self, body=None, raw=None, content_type="application/json", chunked=False):
        if raw is None:
            raw = json_text(body).encode("utf-8")
        request = SimpleNamespace(content_type=content_type,
                                  content_length=None if chunked else len(raw), content=BodyStream(raw))
        return await self.handlers["POST"](request)

    @staticmethod
    def body(response):
        return json.loads(response.body)

    async def test_register_routes_is_lazy_idempotent_and_returns_store(self):
        self.assertEqual([(route.method, route.path) for route in self.server.routes],
                         [("GET", "/mobile/api/settings"), ("POST", "/mobile/api/settings")])
        self.assertFalse(self.store._loaded)
        self.assertIs(settings.register_phone_settings(self.server), self.store)
        self.assertEqual(len(self.server.routes), 2)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_get_and_post_snapshots_and_no_cache_headers(self):
        response = await self.handlers["GET"](None)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response), {"ok": True, "revision": 0, "saved_at": 0,
                                               "exists": False, "retry_after_ms": 0, "values": {}})
        self.assertIn("no-store", response.headers["Cache-Control"])
        response = await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response)["values"], {COLS_KEY: "3"})
        self.assertTrue(self.body(response)["exists"])
        self.assertEqual(self.body(response)["saved_at"], self.clock.milliseconds)

    async def test_conflict_remains_ok_false_and_has_authoritative_snapshot(self):
        await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})
        response = await self.post({"base_revision": 0, "changes": {RANDOM_KEY: "1"}})
        body = self.body(response)
        self.assertEqual(response.status, 409)
        self.assertIs(body["ok"], False)
        self.assertIs(body["conflict"], True)
        self.assertEqual(body["revision"], 1)
        self.assertEqual(body["values"], {COLS_KEY: "3"})
        self.assertEqual(body["saved_at"], self.clock.milliseconds)
        self.assertEqual(body["retry_after_ms"], 60_000)
        self.assertNotIn("Retry-After", response.headers)

    async def test_429_retry_after_rounding_noop_and_exact_boundary(self):
        await self.post({"base_revision": 0, "changes": {COLS_KEY: "2"}})
        response = await self.post({"base_revision": 1, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 429)
        self.assertEqual(response.headers["Retry-After"], "60")
        self.assertIs(self.body(response)["ok"], False)
        self.clock.advance(58_999)
        response = await self.post({"base_revision": 1, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.headers["Retry-After"], "2")
        self.assertEqual(self.body(response)["retry_after_ms"], 1001)
        self.clock.advance(1000)
        response = await self.post({"base_revision": 1, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 429)
        self.assertEqual(response.headers["Retry-After"], "1")
        self.assertEqual(self.body(response)["retry_after_ms"], 1)
        response = await self.post({"base_revision": 1, "changes": {COLS_KEY: "2"}})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response)["revision"], 1)
        self.assertNotIn("Retry-After", response.headers)
        self.clock.advance(1)
        response = await self.post({"base_revision": 1, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response)["revision"], 2)

    async def test_basic_body_validation_returns_json_errors_without_writes(self):
        bodies = [None, [], "text", {}, {"changes": {}}, {"base_revision": 0},
                  {"base_revision": True, "changes": {}}, {"base_revision": -1, "changes": {}},
                  {"base_revision": 0.0, "changes": {}}, {"base_revision": "0", "changes": {}},
                  {"base_revision": 0, "changes": []},
                  {"base_revision": 0, "changes": {}, "graph": {}},
                  {"base_revision": 0, "changes": {"unknown": None}},
                  {"base_revision": 0, "changes": {COLS_KEY: 2}}]
        for body in bodies:
            with self.subTest(body=body):
                response = await self.post(body)
                self.assertEqual(response.status, 400)
                self.assertIs(self.body(response)["ok"], False)
        for raw in (b"", b"{broken", b"\xff", b'{"base_revision":0,"changes":{},"changes":{}}',
                    b'{"base_revision":NaN,"changes":{}}', b"[" * 1200 + b"0" + b"]" * 1200):
            with self.subTest(raw=raw[:60]):
                response = await self.post(raw=raw)
                self.assertEqual(response.status, 400)
                self.assertIs(self.body(response)["ok"], False)
        self.assertFalse(self.store.path.exists())

    async def test_content_type_and_known_oversize_rejected_before_reading_body(self):
        response = await self.post({"base_revision": 0, "changes": {}}, content_type="text/plain")
        self.assertEqual(response.status, 415)
        request = SimpleNamespace(content_type="application/json",
                                  content_length=settings.MAX_BYTES + 1, content=BodyStream(b""))
        response = await self.handlers["POST"](request)
        self.assertEqual(response.status, 413)
        self.assertFalse(request.content.started)
        self.assertIs(self.body(response)["ok"], False)
        self.assertFalse(self.store.path.exists())

    async def test_chunked_body_enforces_same_request_limit(self):
        response = await self.post(raw=b" " * (settings.MAX_BYTES + 1), chunked=True)
        self.assertEqual(response.status, 413)
        self.assertIs(self.body(response)["ok"], False)
        response = await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}}, chunked=True)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response)["revision"], 1)

    async def test_corruption_and_write_failure_are_503_not_fresh_state(self):
        self.store.path.write_bytes(b"broken")
        self.store.backup_path.write_bytes(b"also broken")
        for response in (await self.handlers["GET"](None),
                         await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})):
            self.assertEqual(response.status, 503)
            self.assertIs(self.body(response)["ok"], False)
        self.assertEqual(self.store.path.read_bytes(), b"broken")
        self.assertEqual(self.store.backup_path.read_bytes(), b"also broken")

    async def test_route_write_failure_keeps_revision_and_allows_immediate_retry(self):
        with mock.patch.object(self.store, "_commit", side_effect=OSError("disk failure")):
            response = await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 503)
        self.assertIs(self.body(response)["ok"], False)
        self.assertEqual(self.body(response)["revision"], 0)
        self.assertEqual(self.body(response)["retry_after_ms"], 0)
        response = await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.body(response)["revision"], 1)

    async def test_both_handlers_execute_store_operations_off_event_loop(self):
        event_loop_thread = threading.get_ident()
        workers = []
        original_snapshot, original_save = self.store.snapshot, self.store.save_json

        def snapshot():
            workers.append(threading.get_ident())
            return original_snapshot()

        def save_json(raw):
            workers.append(threading.get_ident())
            return original_save(raw)

        with mock.patch.object(self.store, "snapshot", side_effect=snapshot), \
                mock.patch.object(self.store, "save_json", side_effect=save_json):
            get = await self.handlers["GET"](None)
            post = await self.post({"base_revision": 0, "changes": {COLS_KEY: "3"}})
        self.assertEqual((get.status, post.status), (200, 200))
        self.assertEqual(len(workers), 2)
        self.assertTrue(all(worker != event_loop_thread for worker in workers))


if __name__ == "__main__":
    unittest.main(verbosity=2)
