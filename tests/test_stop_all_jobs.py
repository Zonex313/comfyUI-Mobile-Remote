"""「停止全部」必须先清队列再中断当前任务，顺序反了会漏掉一条。"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_stop_all_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class FakeQueue:
    """记录调用顺序的假队列。"""

    def __init__(self, running, pending, alive=None):
        self.running = running
        self.pending = pending
        # alive=None 表示快照里的运行任务都还活着；给集合可模拟"快照之后它已经结束"
        self.alive = None if alive is None else set(alive)
        self.calls = []
        self.deleted = False

    def get_current_queue_volatile(self):
        self.calls.append("snapshot")
        return (self.running, self.pending)

    def delete_queue_item(self, predicate):
        self.calls.append("clear")
        self.deleted = True
        kept = [item for item in self.pending if not predicate(item)]
        removed = len(self.pending) - len(kept)
        self.pending = kept
        return removed

    def interrupt_if_running(self, prompt_id):
        self.calls.append("interrupt:" + str(prompt_id))
        if self.alive is not None:
            return prompt_id in self.alive
        return any(item[1] == prompt_id for item in self.running)


class StopAllTests(unittest.TestCase):
    def test_queue_is_cleared_before_the_running_job_is_stopped(self):
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=[(2, "p2", {}, {}, []), (3, "p3", {}, {}, [])])
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(queue.calls, ["snapshot", "clear", "interrupt:run-1"])
        self.assertEqual(removed, 2)
        self.assertTrue(interrupted)
        self.assertEqual(queue.pending, [])

    def test_nothing_queued_only_stops_the_running_job(self):
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=[])
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(queue.calls, ["snapshot", "interrupt:run-1"])
        self.assertEqual(removed, 0)
        self.assertTrue(interrupted)

    def test_idle_queue_does_nothing(self):
        queue = FakeQueue(running=[], pending=[])
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual(queue.calls, ["snapshot"])
        self.assertEqual((removed, interrupted), (0, False))

    def test_reports_not_interrupted_when_the_running_job_just_finished(self):
        # 快照里有它，但中断时它已经结束：不能谎报"已中断"
        queue = FakeQueue(running=[(1, "run-1", {}, {}, [])], pending=[], alive=set())
        removed, interrupted = server._stop_all_jobs(queue)
        self.assertEqual((removed, interrupted), (0, False))
        self.assertEqual(queue.calls, ["snapshot", "interrupt:run-1"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
