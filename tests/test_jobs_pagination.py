"""GET /mobile/api/jobs 的分页与 gzip：只装饰返回的那一页，压不压由客户端说了算。"""
from __future__ import annotations

import gzip
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = ROOT.parents[1]

spec = importlib.util.spec_from_file_location("mobile_server_pagination_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def _load_jobs_module():
    """把配套 ComfyUI 的 comfy_execution/jobs.py 单独载进来。

    分页得和线上用同一套排序/过滤规则，所以不自己抄一份 get_all_jobs。
    jobs.py 只额外依赖 comfy_api.internal.prune_dict，给个等价替身就够，不必拖起整套 ComfyUI。
    """
    internal = types.ModuleType("comfy_api.internal")
    internal.prune_dict = lambda data: {key: value for key, value in data.items() if value is not None}
    api = types.ModuleType("comfy_api")
    api.internal = internal
    sys.modules.setdefault("comfy_api", api)
    sys.modules.setdefault("comfy_api.internal", internal)

    package = types.ModuleType("comfy_execution")
    package.__path__ = []
    sys.modules.setdefault("comfy_execution", package)

    path = COMFY_ROOT / "comfy_execution" / "jobs.py"
    jobs_spec = importlib.util.spec_from_file_location("comfy_execution.jobs", path)
    module = importlib.util.module_from_spec(jobs_spec)
    assert jobs_spec.loader is not None
    jobs_spec.loader.exec_module(module)
    sys.modules["comfy_execution.jobs"] = module
    return module


JOBS = _load_jobs_module()


def _queue_item(prompt_id: str, create_time: int) -> tuple:
    """队列条目的 5 元组形态：priority, prompt_id, prompt, extra_data, outputs。"""
    return (0, prompt_id, {}, {"create_time": create_time}, {})


def _history_entry(prompt_id: str, create_time: int, status_str: str = "success") -> dict:
    """历史条目：create_time 在 prompt 元组第 4 位，_history_entry_time 就取这里。"""
    return {
        "prompt": [0, prompt_id, {}, {"create_time": create_time}, {}],
        "outputs": {},
        "status": {"status_str": status_str, "messages": []},
    }


def _restored(count: int, base: int = 1000, step: int = 1) -> list[tuple[str, dict]]:
    return [(f"old-{index:03d}", _history_entry(f"old-{index:03d}", base + index * step)) for index in range(count)]


def _run_payload(
    limit: int,
    offset: int,
    *,
    restored: list | None = None,
    live: dict | None = None,
    running: list | None = None,
    pending: list | None = None,
    favorites: set | None = None,
    favorite_times: dict | None = None,
    statuses: list | None = None,
    summary: bool = True,
):
    """跑一遍真实的分页函数，只把「磁盘 + ComfyUI 运行时」换成替身。

    返回 (响应, 账本)；账本记下 _decorate_job / _persisted_job 各被谁调过，
    用来验证「贵的那一步只作用在返回的这一页上」。
    """
    ledger = {"decorated": [], "persisted": [], "favorite_cards": []}

    def fake_decorate(job, history_item=None):
        ledger["decorated"].append(str(job.get("id", "")))
        decorated = dict(job)
        decorated.setdefault("workflow_name", "测试工作流")
        return decorated

    def fake_persisted(job_id, entry):
        ledger["persisted"].append(str(job_id))
        return {
            "id": str(job_id),
            "status": server._history_entry_status(entry),
            "priority": 0,
            "create_time": server._history_entry_time(entry),
            "persisted": True,
        }

    def fake_favorite_card(job_id):
        ledger["favorite_cards"].append(str(job_id))
        return {
            "id": str(job_id),
            "status": "completed",
            "priority": 0,
            "create_time": server._history_entry_time(server._history_item_from_favorite_meta(job_id)),
            "persisted": True,
        }

    def fake_favorite_entry(job_id):
        return _history_entry(str(job_id), int((favorite_times or {}).get(str(job_id), 0)))

    with mock.patch.object(server, "_queue_snapshot", return_value=(list(running or []), list(pending or []), dict(live or {}))), \
            mock.patch.object(server, "_sync_history_from_live"), \
            mock.patch.object(server, "_history_cache_items", return_value=list(restored or [])), \
            mock.patch.object(server, "_favorite_job_ids", return_value=set(favorites or ())), \
            mock.patch.object(server, "_history_item_from_favorite_meta", side_effect=fake_favorite_entry), \
            mock.patch.object(server, "_favorite_only_job", side_effect=fake_favorite_card), \
            mock.patch.object(server, "_persisted_job", side_effect=fake_persisted), \
            mock.patch.object(server, "_decorate_job", side_effect=fake_decorate):
        payload = server._get_mobile_jobs_payload(limit, offset, list(statuses or []), summary)
    return payload, ledger


def _ids(payload: dict) -> list[str]:
    return [str(job.get("id", "")) for job in payload["jobs"]]


class JobsPaginationTests(unittest.TestCase):
    """limit/offset 要真的切到恢复出来的历史条目上，运行中/排队中永远在页里。"""

    def test_first_page_is_newest_window(self):
        """第 1 页 = create_time 最新的 limit 条（offset 0）。"""
        payload, _ledger = _run_payload(4, 0, restored=_restored(10))
        self.assertTrue(payload["ok"])
        self.assertEqual(_ids(payload), ["old-009", "old-008", "old-007", "old-006"])
        self.assertEqual(payload["total"], 10)
        self.assertTrue(payload["has_more"])

    def test_second_page_continues_where_client_stopped(self):
        """翻页：offset = 客户端已加载条数，第 2 页接着往下切。"""
        first, _ = _run_payload(4, 0, restored=_restored(10))
        second, _ = _run_payload(4, 4, restored=_restored(10))
        self.assertEqual(_ids(second), ["old-005", "old-004", "old-003", "old-002"])
        self.assertEqual(set(_ids(first)) & set(_ids(second)), set())
        self.assertEqual(second["total"], 10)
        self.assertTrue(second["has_more"])

    def test_last_page_stops_advertising_more(self):
        """最后一页 has_more=False，条数不足 limit 也不补齐。"""
        payload, _ = _run_payload(4, 8, restored=_restored(10))
        self.assertEqual(_ids(payload), ["old-001", "old-000"])
        self.assertEqual(payload["total"], 10)
        self.assertFalse(payload["has_more"])

    def test_offset_past_end_is_empty(self):
        """越界翻页：空 jobs，has_more=False，total 照旧。"""
        for offset in (10, 12, 400):
            payload, _ = _run_payload(4, offset, restored=_restored(10))
            self.assertEqual(payload["jobs"], [])
            self.assertEqual(payload["total"], 10)
            self.assertFalse(payload["has_more"])

    def test_limit_does_not_change_total(self):
        """total 是完整列表的条数，跟这一页取多少无关。"""
        small, _ = _run_payload(3, 0, restored=_restored(23))
        large, _ = _run_payload(20, 0, restored=_restored(23))
        self.assertEqual(small["total"], 23)
        self.assertEqual(large["total"], 23)
        self.assertEqual(len(small["jobs"]), 3)
        self.assertEqual(len(large["jobs"]), 20)

    def test_pagination_covers_persisted_history_too(self):
        """恢复出来的历史（570 多条那种）和实时任务同属一个完整列表，一起参与分页。"""
        live = {"live-1": _history_entry("live-1", 9000)}
        payload, _ = _run_payload(3, 0, restored=_restored(10), live=live)
        self.assertEqual(_ids(payload), ["live-1", "old-009", "old-008"])
        self.assertEqual(payload["total"], 11)
        tail, _ = _run_payload(3, 9, restored=_restored(10), live=live)
        self.assertEqual(_ids(tail), ["old-001", "old-000"])   # 历史条目真的能翻到
        self.assertFalse(tail["has_more"])


class JobsRunningAlwaysVisibleTests(unittest.TestCase):
    """运行中/排队中的任务不受 limit 限制，create_time 再老也必须出现在返回里。"""

    def test_running_job_outside_window_is_still_returned(self):
        payload, _ = _run_payload(2, 0, restored=_restored(10), running=[_queue_item("run-old", 1)])
        ids = _ids(payload)
        self.assertIn("run-old", ids)
        self.assertEqual(len(ids), 3)                       # 2 条窗口 + 1 条运行中
        self.assertEqual(payload["total"], 11)              # 它本来就在完整列表里
        self.assertEqual(ids[-1], "run-old")                # 仍然是 create_time 倒序

    def test_pending_job_on_late_page_is_still_returned(self):
        """窗口已经翻到底了，排队中的任务依然要出现。"""
        payload, _ = _run_payload(2, 10, restored=_restored(10), pending=[_queue_item("wait-old", 2)])
        self.assertEqual(_ids(payload), ["wait-old"])
        self.assertEqual(payload["total"], 11)      # 它本来就在完整列表里
        self.assertFalse(payload["has_more"])
        times = [job["create_time"] for job in payload["jobs"]]
        self.assertEqual(times, sorted(times, reverse=True))

    def test_live_job_inside_window_is_not_duplicated(self):
        live = {"fresh": _history_entry("fresh", 9999)}
        payload, ledger = _run_payload(3, 0, restored=_restored(10), live=live)
        self.assertEqual(_ids(payload), ["fresh", "old-009", "old-008"])
        self.assertEqual(ledger["decorated"].count("fresh"), 1)

    def test_summary_false_keeps_full_job_shape(self):
        """summary=0 时只是不裁剪字段，分页行为一致。"""
        payload, _ = _run_payload(2, 0, restored=_restored(10), summary=False)
        self.assertEqual(_ids(payload), ["old-009", "old-008"])
        self.assertIn("persisted", payload["jobs"][0])
        self.assertEqual(payload["total"], 10)
        self.assertTrue(payload["has_more"])

    def test_favorites_ride_along_with_the_first_page(self):
        """收藏任务既在完整列表里（靠排序和翻页翻得到），也会额外挂在第一页上。

        后者是必须的：手机端首屏只拉最近 N 条，收藏往往落在很旧的位置，
        不额外带上的话「只看收藏」视图会空白。附加条目标 favorite_extra，
        手机端的按时间列表会把它过滤掉，所以正常历史列表不受影响。
        """
        # 收藏夹里还有卡片、索引里已经找不到的任务：create_time 1055，夹在 old-005 和 old-006 之间
        args = dict(restored=_restored(10, step=10), favorites={"fav-1"}, favorite_times={"fav-1": 1055})
        first, first_ledger = _run_payload(3, 0, **args)
        self.assertEqual(_ids(first)[:3], ["old-009", "old-008", "old-007"])
        self.assertIn("fav-1", _ids(first))                 # 首屏就带上收藏
        self.assertEqual(len(first["jobs"]), 4)
        self.assertTrue(next(job for job in first["jobs"] if job["id"] == "fav-1")["favorite_extra"])
        self.assertEqual(first["total"], 11)                # 它在完整列表里，total 算它
        self.assertEqual(first_ledger["favorite_cards"], ["fav-1"])

        second, second_ledger = _run_payload(3, 3, **args)
        self.assertEqual(_ids(second), ["old-006", "fav-1", "old-005"])
        self.assertEqual(second_ledger["favorite_cards"], ["fav-1"])
        # 翻页时不再重复附加（客户端按 id 去重，这里确保服务端也没多塞）
        self.assertFalse(any(job.get("favorite_extra") for job in second["jobs"]))


class JobsDecorateCostTests(unittest.TestCase):
    """贵的那一步（查磁盘、建缩略图）只能作用在返回的这一页上。"""

    def test_only_page_entries_are_persisted_and_decorated(self):
        payload, ledger = _run_payload(5, 5, restored=_restored(40), running=[_queue_item("run-1", 1)])
        page_ids = _ids(payload)
        self.assertEqual(len(page_ids), 6)                  # 5 条窗口 + 1 条运行中
        self.assertEqual(ledger["decorated"], page_ids)     # 只装饰这一页，不是 40 条
        # 运行中的那条直接来自队列，不走 _persisted_job 展开
        self.assertEqual(sorted(ledger["persisted"]), sorted(i for i in page_ids if i != "run-1"))

    def test_page_one_decorates_exactly_limit_entries(self):
        payload, ledger = _run_payload(60, 0, restored=_restored(570))
        self.assertEqual(len(payload["jobs"]), 60)
        self.assertEqual(len(ledger["decorated"]), 60)
        self.assertEqual(ledger["decorated"], _ids(payload))
        self.assertEqual(len(ledger["persisted"]), 60)
        self.assertEqual(payload["total"], 570)
        self.assertTrue(payload["has_more"])

    def test_deep_page_decorates_only_its_own_window(self):
        """翻到第 10 页，代价还是这一页的条数，不是前面 540 条。"""
        deep, deep_ledger = _run_payload(60, 540, restored=_restored(570))
        self.assertEqual(len(deep["jobs"]), 30)                 # 最后一页只剩 30 条
        self.assertEqual(deep_ledger["decorated"], _ids(deep))
        self.assertEqual(len(deep_ledger["persisted"]), 30)     # 不是 570
        self.assertFalse(deep["has_more"])


def _sample_payload(jobs: int = 60) -> dict:
    """一份形状接近线上 summary=1 的载荷：每条带一张缩略图描述。"""
    return {
        "ok": True,
        "jobs": [
            {
                "id": f"4f0d0cfb-7d69-4150-bb4c-{index:012d}",
                "status": "completed",
                "priority": 0,
                "create_time": 1770000000000 - index * 1000,
                "outputs_count": 1,
                "previewable_outputs_count": 1,
                "preview_output": {"filename": f"t2i_{index:05d}_.png", "subfolder": "", "type": "output", "mediaType": "images", "favorite": False},
                "workflow_id": "df40740e14bf24ae68ea",
                "workflow_name": "手机工作流",
                "model_name": "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
                "persisted": True,
                "seed": 123456789,
                "gallery": [{"filename": f"t2i_{index:05d}_.png", "subfolder": "", "type": "output", "mediaType": "images", "favorite": False}],
                "favorite_extra": False,
            }
            for index in range(jobs)
        ],
        "total": jobs,
        "has_more": False,
    }


class _FakeRequest:
    def __init__(self, accept_encoding: str):
        self.headers = {"Accept-Encoding": accept_encoding}


class JobsGzipTests(unittest.TestCase):
    """几百 KB 的任务列表：客户端说支持 gzip 就压，不支持就原样，小载荷不折腾。"""

    def test_helper_compresses_at_level_one(self):
        payload = _sample_payload()
        raw = server._json_bytes(payload)
        packed = server._gzip_json_bytes(payload)
        self.assertGreater(len(raw), server.GZIP_MIN_BYTES)
        self.assertEqual(gzip.decompress(packed), raw)
        self.assertLess(len(packed), len(raw) // 3)                 # 这种高度重复的 JSON 压得动
        self.assertEqual(len(packed), len(gzip.compress(raw, 1)))   # level 1，不是默认的 9

    def test_accepts_gzip_sets_content_encoding(self):
        payload = _sample_payload()
        response = server._mobile_jobs_response(payload, True)
        self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.assertEqual(response.headers["Content-Type"], "application/json")
        self.assertEqual(response.headers["Cache-Control"], server.NO_CACHE["Cache-Control"])
        self.assertEqual(response.content_length, len(response.body))   # 报的是压缩后的长度
        self.assertEqual(json.loads(gzip.decompress(response.body).decode("utf-8")), payload)

    def test_without_accept_gzip_body_is_untouched(self):
        payload = _sample_payload()
        response = server._mobile_jobs_response(payload, False)
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertEqual(response.body, server._json_bytes(payload))
        self.assertEqual(json.loads(response.body.decode("utf-8")), payload)

    def test_small_payload_is_not_compressed(self):
        payload = {"ok": True, "jobs": [], "total": 0, "has_more": False}
        raw = server._json_bytes(payload)
        self.assertLessEqual(len(raw), server.GZIP_MIN_BYTES)       # 前提：确实在阈值以下
        response = server._mobile_jobs_response(payload, True)
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertEqual(response.body, raw)

    def test_client_accepts_gzip_reads_accept_encoding(self):
        self.assertTrue(server._client_accepts_gzip(_FakeRequest("gzip, deflate, br")))
        self.assertTrue(server._client_accepts_gzip(_FakeRequest("GZIP")))
        self.assertFalse(server._client_accepts_gzip(_FakeRequest("deflate, br")))
        self.assertFalse(server._client_accepts_gzip(_FakeRequest("")))

    def test_compressed_and_plain_carry_the_same_json(self):
        """压不压只是传输形态：解压后能 json.loads 回来，jobs 数量一致。"""
        payload = _sample_payload()
        packed = server._mobile_jobs_response(payload, True).body
        plain = server._mobile_jobs_response(payload, False).body
        self.assertNotEqual(packed, plain)
        decoded = json.loads(gzip.decompress(packed).decode("utf-8"))
        self.assertEqual(decoded, json.loads(plain.decode("utf-8")))
        self.assertEqual(len(decoded["jobs"]), len(payload["jobs"]))
        self.assertEqual(_ids(decoded), _ids(payload))


class JobsRouteHttpTests(unittest.IsolatedAsyncioTestCase):
    """真的走一次 HTTP：带 Accept-Encoding 的客户端拿到的就是 gzip。"""

    async def asyncSetUp(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer

        payload = _sample_payload()

        async def handler(request):
            return server._mobile_jobs_response(payload, server._client_accepts_gzip(request))

        app = web.Application()
        app.router.add_get("/mobile/api/jobs", handler)
        self.client = TestClient(TestServer(app), auto_decompress=False)
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_gzip_round_trip_over_http(self):
        response = await self.client.get("/mobile/api/jobs", headers={"Accept-Encoding": "gzip"})
        body = await response.read()
        self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.assertEqual(response.headers["Content-Type"], "application/json")
        self.assertEqual(int(response.headers["Content-Length"]), len(body))
        self.assertEqual(json.loads(gzip.decompress(body).decode("utf-8"))["ok"], True)

    async def test_plain_round_trip_over_http(self):
        response = await self.client.get("/mobile/api/jobs", headers={"Accept-Encoding": "identity"})
        body = await response.read()
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertEqual(json.loads(body.decode("utf-8"))["ok"], True)


class FavoriteExtraTests(unittest.TestCase):
    """首屏必须额外带上收藏任务：手机端只拉最近 N 条，而收藏往往落在很旧的位置
    （实测本机 158 个收藏任务没有一个在最新 60 条里），不带的话「只看收藏」视图会空白。"""

    def _payload(self, limit=3, offset=0, favorites=None, maximum=None):
        kwargs = {}
        if maximum is not None:
            kwargs["new"] = maximum
        patch = mock.patch.object(server, "FAVORITE_EXTRA_MAX", maximum) if maximum is not None else mock.patch.object(server, "FAVORITE_EXTRA_MAX", 400)
        with patch:
            return _run_payload(
                limit,
                offset,
                restored=_restored(10),
                favorites=favorites or set(),
                favorite_times={f"old-{index:03d}": 1000 + index for index in range(10)},
            )

    def test_first_page_carries_every_favorite(self):
        payload, ledger = self._payload(favorites={"old-001", "old-008"})
        jobs = payload["jobs"]
        ids = [job["id"] for job in jobs]
        # 窗口（最新 3 条）在前，窗口外的收藏附在后面
        self.assertEqual(ids[:3], ["old-009", "old-008", "old-007"])
        self.assertIn("old-001", ids)
        # 窗口里的条目照常显示，窗口外的收藏标成 favorite_extra
        by_id = {job["id"]: job for job in jobs}
        self.assertFalse(by_id["old-009"]["favorite_extra"])
        self.assertFalse(by_id["old-008"]["favorite_extra"])
        self.assertTrue(by_id["old-001"]["favorite_extra"])
        # 附加条目确实被装饰过（不是空壳）
        self.assertIn("old-001", ledger["decorated"])

    def test_favorite_inside_window_is_not_duplicated(self):
        payload, _ = self._payload(favorites={"old-008"})
        ids = [job["id"] for job in payload["jobs"]]
        self.assertEqual(ids.count("old-008"), 1)
        self.assertEqual(len(ids), 3)

    def test_later_pages_do_not_repeat_favorites(self):
        payload, _ = self._payload(limit=3, offset=3, favorites={"old-001", "old-008"})
        ids = [job["id"] for job in payload["jobs"]]
        self.assertEqual(ids, ["old-006", "old-005", "old-004"])
        self.assertFalse(any(job.get("favorite_extra") for job in payload["jobs"]))

    def test_extra_favorites_are_capped(self):
        favorites = {f"old-{index:03d}" for index in range(10)}
        payload, _ = self._payload(favorites=favorites, maximum=2)
        extras = [job for job in payload["jobs"] if job.get("favorite_extra")]
        self.assertEqual(len(extras), 2)

    def test_no_favorites_means_no_extras(self):
        payload, _ = self._payload(favorites=set())
        self.assertEqual([job["id"] for job in payload["jobs"]], ["old-009", "old-008", "old-007"])

    def test_total_and_has_more_ignore_the_extras(self):
        payload, _ = self._payload(limit=3, favorites={f"old-{index:03d}" for index in range(10)})
        self.assertEqual(payload["total"], 10)
        self.assertTrue(payload["has_more"])
        self.assertGreater(len(payload["jobs"]), 3)   # 窗口 3 条 + 收藏附加


if __name__ == "__main__":
    unittest.main(verbosity=2)

