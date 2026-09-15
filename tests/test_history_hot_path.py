"""读取接口的热路径：不写盘、缩略图结果复用。"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_hotpath_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def _fake_prompt_server(history: dict) -> types.SimpleNamespace:
    queue = types.SimpleNamespace(get_history=lambda **_kwargs: history)
    return types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=queue)))


class SyncMaintenanceTests(unittest.TestCase):
    """请求路径只更新内存缓存；重写索引和收藏元数据交给后台定时器。"""

    def _run(self, maintenance: bool):
        history = {"job-1": {"prompt": [], "outputs": {}, "status": {}}}
        old = sys.modules.get("server")
        sys.modules["server"] = _fake_prompt_server(history)
        try:
            with mock.patch.object(server, "_persist_history_index_if_due") as persist, \
                    mock.patch.object(server, "_backfill_favorite_meta") as backfill, \
                    mock.patch.object(server, "_scrub_stale_history_images", return_value=True), \
                    mock.patch.object(server, "_load_history_index", return_value={}):
                server._sync_history_from_live(maintenance)
        finally:
            if old is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = old
        return persist, backfill

    def test_request_path_writes_nothing(self):
        persist, backfill = self._run(maintenance=False)
        persist.assert_not_called()
        backfill.assert_not_called()

    def test_background_timer_still_does_maintenance(self):
        persist, backfill = self._run(maintenance=True)
        persist.assert_called_once()
        backfill.assert_called_once()


class MaintenanceThrottleTests(unittest.TestCase):
    """后台维护本身也别做无用功：限频，而且绝不阻塞读取请求。"""

    def test_request_path_does_not_wait_for_maintenance(self):
        import time as _time

        server._HISTORY_SYNC_LOCK.acquire()
        try:
            with mock.patch.object(server, "_sync_history_from_live_unlocked") as inner:
                started = _time.perf_counter()
                server._sync_history_from_live(False)
                elapsed = _time.perf_counter() - started
            inner.assert_not_called()
            self.assertLess(elapsed, 0.1)
        finally:
            server._HISTORY_SYNC_LOCK.release()

    def test_favorite_meta_backfill_is_throttled(self):
        import time as _time

        server._FAVORITE_META_BACKFILL_AT = _time.monotonic()
        try:
            with mock.patch.object(server, "_favorite_disk_job_ids") as disk:
                server._backfill_favorite_meta()
            disk.assert_not_called()
        finally:
            server._FAVORITE_META_BACKFILL_AT = 0.0
        with mock.patch.object(server, "_favorite_disk_job_ids", return_value=set()) as disk:
            server._backfill_favorite_meta()
        disk.assert_called_once()

    def test_history_persist_is_throttled(self):
        import time as _time

        server._HISTORY_PERSIST_AT = _time.monotonic()
        try:
            with mock.patch.object(server, "_persist_history_index") as persist:
                server._persist_history_index_if_due()
            persist.assert_not_called()
        finally:
            server._HISTORY_PERSIST_AT = 0.0
        with mock.patch.object(server, "_persist_history_index") as persist:
            server._persist_history_index_if_due()
        persist.assert_called_once()


class FavoriteMetaWriteTests(unittest.TestCase):
    def test_unchanged_meta_is_not_rewritten(self):
        with tempfile.TemporaryDirectory(prefix="fav-meta-") as tmp:
            root = Path(tmp)
            job_id = "job-meta-1"
            folder = root / job_id
            folder.mkdir()
            (folder / "shot.png").write_bytes(b"x")
            entry = {"prompt": [0, job_id, {"1": {"class_type": "KSampler", "inputs": {"seed": 7}}}, {}], "status": {}}
            with mock.patch.object(server, "FAVORITE_FILES", root), \
                    mock.patch.object(server, "_favorite_disk_job_ids", return_value={job_id}), \
                    mock.patch.object(server, "_history_entry_for_favorite", return_value=entry):
                server._write_favorite_meta(job_id)
                first = json.loads((folder / "job.json").read_text(encoding="utf-8"))
                with mock.patch.object(server, "_write_json_atomic") as write:
                    server._write_favorite_meta(job_id)
                write.assert_not_called()
            self.assertEqual(first["job_id"], job_id)


class GalleryCacheTests(unittest.TestCase):
    def setUp(self):
        server._GALLERY_CACHE.clear()
        server._bump_gallery_revision()

    def _entry(self):
        return {
            "prompt": [0, "job-1", {}, {}],
            "outputs": {"9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"}]}},
            "status": {"completed": True},
        }

    def test_same_entry_reuses_cached_gallery(self):
        entry = self._entry()
        with mock.patch.object(server, "_media_item_fresh", return_value=True), \
                mock.patch.object(server, "_history_gallery_uncached", wraps=server._history_gallery_uncached) as inner:
            first = server._history_gallery(entry, "job-1")
            second = server._history_gallery(entry, "job-1")
        self.assertEqual(first, second)
        self.assertIsNot(first, second)  # 返回副本，调用方改不脏缓存
        self.assertEqual(inner.call_count, 1)
        self.assertIn("job-1", server._GALLERY_CACHE)

    def test_revision_bump_invalidates_cache(self):
        entry = self._entry()
        with mock.patch.object(server, "_media_item_fresh", return_value=True), \
                mock.patch.object(server, "_history_gallery_uncached", wraps=server._history_gallery_uncached) as inner:
            server._history_gallery(entry, "job-1")
            server._bump_gallery_revision()
            server._history_gallery(entry, "job-1")
        self.assertEqual(inner.call_count, 2)

    def test_new_entry_object_invalidates_identity_cache(self):
        with mock.patch.object(server, "_media_item_fresh", return_value=True), \
                mock.patch.object(server, "_history_gallery_uncached", wraps=server._history_gallery_uncached) as inner:
            server._history_gallery(self._entry(), "job-1")
            server._history_gallery(self._entry(), "job-1")
        self.assertEqual(inner.call_count, 2)

    def test_empty_job_id_is_not_cached(self):
        entry = self._entry()
        with mock.patch.object(server, "_media_item_fresh", return_value=True):
            server._history_gallery(entry, "")
        self.assertEqual(server._GALLERY_CACHE, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
