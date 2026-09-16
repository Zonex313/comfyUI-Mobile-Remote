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


# 这个文件的用例会走到真实的落盘分支。曾经因为少 mock 了一层，一次测试运行
# 就把用户的 mobile_history.json 覆盖成了这里的夹具；现在把插件的数据路径
# 整体挪到临时目录，跑测试再也不可能碰到真实数据。
_SANDBOX_DIR = None
_SANDBOX = None


def setUpModule():
    global _SANDBOX_DIR, _SANDBOX
    _SANDBOX_DIR = tempfile.TemporaryDirectory(prefix="history-hotpath-")
    root = Path(_SANDBOX_DIR.name)
    _SANDBOX = mock.patch.multiple(
        server,
        HISTORY_INDEX_PATH=root / "mobile_history.json",
        FAVORITES_PATH=root / "mobile_favorites.json",
        FAVORITE_FILES=root / "favorite_files",
        WORKFLOW_ROOT=root / "workflows",
        DRAFT_ROOT=root / "drafts",
    )
    _SANDBOX.start()
    # 缓存标志也要清掉，否则下面的路径替换读不到沙箱里的文件。
    server._HISTORY_CACHE.clear()
    server._HISTORY_LOADED = False
    server._FAVORITES.clear()
    server._FAVORITES_LOADED = False


def tearDownModule():
    if _SANDBOX is not None:
        _SANDBOX.stop()
    if _SANDBOX_DIR is not None:
        _SANDBOX_DIR.cleanup()


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

class RealDataSafetyTests(unittest.TestCase):
    """回归：维护路径里那句未被 mock 的 _persist_history_index()，
    曾经把测试夹具当成真实历史写进用户的 mobile_history.json。
    这里故意「只 mock 上层」跑一遍，断言真实数据文件一个字节都没动。"""

    REAL_FILES = ("mobile_history.json", "mobile_favorites.json", "mobile_settings.json")

    def _snapshot(self):
        return {name: (ROOT / name).read_bytes() if (ROOT / name).exists() else None
                for name in self.REAL_FILES}

    def test_maintenance_path_cannot_reach_the_real_data_files(self):
        # 探针编号必须独特：如果哪天沙箱失效、真的写进了真实文件，
        # 字节对比要能立刻看出来，而不是「恰好一样」地蒙混过关。
        probe = "sandbox-probe-must-never-land-in-real-files"
        before = self._snapshot()
        history = {probe: {"prompt": [], "outputs": {}, "status": {}}}
        old = sys.modules.get("server")
        sys.modules["server"] = _fake_prompt_server(history)
        try:
            # 注意：这里刻意不 mock _persist_history_index，让它真的去落盘——
            # 落盘目标必须是沙箱，而不是插件的真实目录。
            with mock.patch.object(server, "_persist_history_index_if_due"), \
                    mock.patch.object(server, "_backfill_favorite_meta"), \
                    mock.patch.object(server, "_scrub_stale_history_images", return_value=True), \
                    mock.patch.object(server, "_load_history_index", return_value={}):
                server._sync_history_from_live(True)
        finally:
            if old is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = old
        after = self._snapshot()
        for name in self.REAL_FILES:
            self.assertEqual(before[name], after[name], f"测试改写了真实的 {name}")
            self.assertNotIn(probe.encode("utf-8"), after[name] or b"", f"探针编号落进了真实的 {name}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
