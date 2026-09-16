"""排队中/运行中的任务（不在 history 里）也要带模型名与提示词。

手机端队列页已删除，但任务详情弹窗与历史链路仍然读这两个字段：
没有它们时任务只能显示兜底标题「电脑端任务」。
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_queue_jobs_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def queue_snapshot(prompt_id="job-1", workflow_name="手机工作流", text="海边写真"):
    """构造一条队列快照（prompt_queue 里存的就是这种五元组）。"""
    prompt = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "landscape-v2.safetensors"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": text}, "_meta": {"title": "正向提示词"}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad quality"}, "_meta": {"title": "反向提示词"}},
    }
    extra = {"mobile_remote": {"workflow_name": workflow_name, "values": {}}}
    return {"prompt": [1, prompt_id, prompt, extra, []]}


class QueueJobMetadataTests(unittest.TestCase):
    def test_pending_job_gets_model_and_prompt(self):
        job = {"id": "job-1", "status": "pending", "create_time": 1}
        decorated = server._decorate_queue_job(job, None, queue_snapshot())
        self.assertEqual(decorated["model_name"], "landscape-v2.safetensors")
        self.assertEqual(decorated["positive_prompt"], "海边写真")
        self.assertEqual(decorated["workflow_name"], "手机工作流")
        # 队列卡片不显示缩略图，不要顺手塞 gallery
        self.assertNotIn("gallery", decorated)

    def test_history_item_wins_over_snapshot(self):
        job = {"id": "job-1", "status": "in_progress", "create_time": 1}
        history_item = {
            "prompt": [1, "job-1", {"9": {"class_type": "CLIPTextEncode", "inputs": {"text": "历史里的提示词"}}}, {}, {}],
            "outputs": {},
        }
        decorated = server._decorate_queue_job(job, history_item, queue_snapshot(text="快照里的提示词"))
        self.assertEqual(decorated["positive_prompt"], "历史里的提示词")

    def test_missing_snapshot_only_falls_back_to_title(self):
        job = {"id": "job-2", "status": "pending", "create_time": 1}
        decorated = server._decorate_queue_job(job, None, None)
        self.assertEqual(decorated["workflow_name"], "电脑端任务")
        self.assertNotIn("positive_prompt", decorated)

    def test_summary_keeps_prompt_only_for_queue_statuses(self):
        pending = server._mobile_job_summary({"id": "a", "status": "pending", "positive_prompt": "提示词"})
        self.assertEqual(pending.get("positive_prompt"), "提示词")
        completed = server._mobile_job_summary({"id": "b", "status": "completed", "positive_prompt": "提示词"})
        self.assertNotIn("positive_prompt", completed)

    def test_negative_prompt_node_is_never_used_as_positive(self):
        snapshot = queue_snapshot(text="")
        graph = snapshot["prompt"][2]
        del graph["6"]
        decorated = server._decorate_queue_job({"id": "job-3", "status": "pending"}, None, snapshot)
        self.assertNotEqual(decorated.get("positive_prompt"), "bad quality")


if __name__ == "__main__":
    unittest.main(verbosity=2)
