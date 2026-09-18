"""「停止全部」必须把所有排队任务清干净，再中断正在执行的那一个。

假队列严格照 ComfyUI execution.py 的 PromptQueue 写：
  * delete_queue_item 命中一条就立刻 return（它只负责删「某一条」）；
  * 整体清空是 wipe_queue；
  * 两者和 interrupt_if_running 都共用同一把 RLock。
之前那份假队列一次把匹配项全删了，与真实行为不符，
所以「只停了一两个任务」的 bug 一直没被测出来。
"""
from __future__ import annotations

import importlib.util
import json
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_stop_all_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class FakeQueue:
    """按 ComfyUI 真实语义实现的假队列（含锁）。"""

    def __init__(self, running=(), pending=(), alive=None, support_wipe=True):
        self.mutex = threading.RLock()
        self.queue = list(pending)
        self.currently_running = {index: item for index, item in enumerate(running)}
        # alive=None 表示运行中的任务都还活着；给集合可模拟「快照之后它已经结束」
        self.alive = None if alive is None else set(alive)
        self.calls = []
        if not support_wipe:
            # 用实例属性盖住类方法，模拟「这个版本的队列没有 wipe_queue」
            self.wipe_queue = None

    def get_current_queue_volatile(self):
        with self.mutex:
            self.calls.append("snapshot")
            return (list(self.currently_running.values()), list(self.queue))

    def delete_queue_item(self, predicate):
        """真实语义：删中一条就返回 True，剩下的原样留着。"""
        with self.mutex:
            self.calls.append("delete")
            for index, item in enumerate(self.queue):
                if predicate(item):
                    self.queue.pop(index)
                    return True
            return False

    def wipe_queue(self):
        with self.mutex:
            self.calls.append("wipe")
            self.queue = []

    def interrupt_if_running(self, prompt_id):
        with self.mutex:
            self.calls.append("interrupt:" + str(prompt_id))
            if self.alive is not None:
                return prompt_id in self.alive
            return any(item[1] == prompt_id for item in self.currently_running.values())


def pending(count):
    return [(index, "p%d" % index, {}, {}, []) for index in range(2, 2 + count)]


class StopAllTests(unittest.TestCase):
    def test_clears_every_pending_job_then_interrupts_the_running_one(self):
        """回归：队列里有几条就要清几条，不能只清一条。"""
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=pending(6))
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(removed, 6)
        self.assertEqual(queue.queue, [])
        self.assertTrue(interrupted)
        self.assertEqual(queue.calls, ["snapshot", "wipe", "interrupt:run-1"])
        self.assertNotIn("delete", queue.calls)

    def test_queue_is_cleared_before_the_running_job_is_stopped(self):
        """顺序不能反：先中断的话下一条会立刻开跑，再清队列就漏了它。"""
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=pending(3))
        server._stop_all_jobs(queue)
        order = [call for call in queue.calls if call in ("wipe", "delete") or call.startswith("interrupt")]
        self.assertEqual(order[0], "wipe")
        self.assertTrue(order[-1].startswith("interrupt"))

    def test_falls_back_to_one_by_one_deletes_without_wipe_queue(self):
        """没有 wipe_queue 的版本：必须循环删到底，只调一次等于没清。"""
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=pending(6), support_wipe=False)
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(removed, 6)
        self.assertEqual(queue.queue, [])
        self.assertTrue(interrupted)
        self.assertEqual(queue.calls.count("delete"), 7)  # 6 条 + 一次确认已经空了

    def test_holds_the_queue_lock_across_clear_and_interrupt(self):
        """清队列与中断之间不能放锁，否则执行线程会取走下一条。"""
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=pending(2))
        held = []
        original_wipe = queue.wipe_queue
        def spy_wipe():
            held.append(queue.mutex._is_owned())
            original_wipe()
        queue.wipe_queue = spy_wipe
        original_interrupt = queue.interrupt_if_running
        def spy_interrupt(prompt_id):
            held.append(queue.mutex._is_owned())
            return original_interrupt(prompt_id)
        queue.interrupt_if_running = spy_interrupt
        server._stop_all_jobs(queue)
        self.assertEqual(held, [True, True])

    def test_nothing_queued_only_stops_the_running_job(self):
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])])
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(removed, 0)
        self.assertTrue(interrupted)
        self.assertEqual(queue.calls, ["snapshot", "interrupt:run-1"])

    def test_idle_queue_does_nothing(self):
        queue = FakeQueue()
        self.assertEqual(server._stop_all_jobs(queue), (0, False))
        self.assertEqual(queue.calls, ["snapshot"])

    def test_reports_not_interrupted_when_the_running_job_just_finished(self):
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], alive=set())
        self.assertEqual(server._stop_all_jobs(queue), (0, False))
        self.assertEqual(queue.calls, ["snapshot", "interrupt:run-1"])


COMFY_ROOT = ROOT.parents[1] if len(ROOT.parents) > 1 else None



REAL_QUEUE_SCRIPT = r"""
import importlib.util, json, pathlib, sys

comfy_root = pathlib.Path(sys.argv[1])
plugin_root = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(comfy_root))
from execution import PromptQueue  # 真实实现

spec = importlib.util.spec_from_file_location("mobile_server_real_queue_under_test", plugin_root / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class StubServer:
    def queue_updated(self):
        pass


def filled(count):
    queue = PromptQueue(server=StubServer())
    for index in range(count):
        queue.put((index, "p%d" % index, {}, {}, []))
    return queue


# 前提：这个接口一次只删一条，不负责清空
probe = filled(5)
deleted_one = probe.delete_queue_item(lambda item: True)
remaining_after_one_delete = len(probe.queue)

# 停止全部：先清空排队，再中断正在执行的那一条
queue = filled(6)
item, _task_id = queue.get()
running_id = item[1]
removed, interrupted = server._stop_all_jobs(queue)

print(json.dumps({
    "deleted_one": deleted_one,
    "remaining_after_one_delete": remaining_after_one_delete,
    "running_id": running_id,
    "removed": removed,
    "pending_after": len(queue.queue),
    "running_after": len(queue.get_current_queue_volatile()[0]),
    "interrupted": interrupted,
}))
"""

COMFY_ROOT = ROOT.parents[1] if len(ROOT.parents) > 1 else None


def run_real_queue_probe():
    """在独立子进程里拿 ComfyUI 真实的 PromptQueue 跑一遍。

    必须单独起进程：别的测试会往 sys.modules 里塞 comfy_api 的替身，
    在同一个进程里 execution.py 就导入不成了——而「真实的那个实现」才是要验的东西。
    """
    import subprocess
    import sys
    if COMFY_ROOT is None or not (COMFY_ROOT / "execution.py").is_file():
        return None, "找不到 ComfyUI 的 execution.py"
    try:
        done = subprocess.run(
            [sys.executable, "-c", REAL_QUEUE_SCRIPT, str(COMFY_ROOT), str(ROOT)],
            cwd=str(COMFY_ROOT), capture_output=True, text=True, timeout=300,
        )
    except Exception as exc:
        return None, "%s: %s" % (type(exc).__name__, exc)
    if done.returncode != 0:
        return None, "子进程退出码 %s：%s" % (done.returncode, (done.stderr or "").strip()[-400:])
    for line in reversed((done.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line), ""
    return None, "子进程没有输出结果：" + (done.stdout or "").strip()[-200:]


REAL_QUEUE_RESULT, REAL_QUEUE_ERROR = run_real_queue_probe()


class RealPromptQueueTests(unittest.TestCase):
    """拿 ComfyUI 真实的队列实现验证：假队列语义不对，才让 bug 溜了过去。"""

    def setUp(self):
        if REAL_QUEUE_RESULT is None:
            self.skipTest("拿不到真实的 PromptQueue —— " + REAL_QUEUE_ERROR)

    def test_delete_queue_item_really_removes_only_one(self):
        """钉住这条前提：它就是「删掉某一条」的接口，清空队列不能靠它。"""
        self.assertTrue(REAL_QUEUE_RESULT["deleted_one"])
        self.assertEqual(REAL_QUEUE_RESULT["remaining_after_one_delete"], 4)

    def test_stop_all_empties_the_real_queue_and_interrupts_the_running_job(self):
        self.assertEqual(REAL_QUEUE_RESULT["running_id"], "p0")
        self.assertEqual(REAL_QUEUE_RESULT["removed"], 5)
        self.assertEqual(REAL_QUEUE_RESULT["pending_after"], 0)
        self.assertEqual(REAL_QUEUE_RESULT["running_after"], 1)
        self.assertTrue(REAL_QUEUE_RESULT["interrupted"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
