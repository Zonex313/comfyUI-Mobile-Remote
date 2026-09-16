"""手机 → 电脑端指令通道：校验、入队、去重、封顶、领取、ack、落盘读回。

不需要 ComfyUI 运行时：工作流记录直接写成 JSON 文件，队列落在临时目录里。
覆盖：
- 合法指令入队（字段形状、值原样带上、pending 计数）；
- 非法 node / input / 畸形键 / 多余字段 / 超长或形状不对的值一律被拒；
- 同 工作流+节点+输入 只留最新一条；
- 队列封顶 50 条（丢最旧的）；
- 领取不删除、按 workflow_id 过滤、ack 才删、畸形 ack 被拒；
- 落盘在 .runtime/ 下，清掉内存副本（等价于换进程）与新进程都能读回；
- 服务端只管排队，绝不动工作流记录里的 prompt。

跑法：
    python.exe -B tests/test_desktop_commands.py
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_commands_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

WORKFLOW_ID = "a" * 20        # _record_path 只认 20 位十六进制
OTHER_WORKFLOW_ID = "b" * 20

PROMPT = {
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "16": {
        "class_type": "MobileTagCLIPTextEncode",
        "inputs": {"clip": ["4", 0], "text": "海边写真", "标签模式": False, "每次随机": True},
    },
}

# 新进程里读回队列用的小程序：只 import server.py、指到同一个队列文件、打印领取结果。
SUBPROCESS_READER = """
import importlib.util, json, sys
from pathlib import Path
root, queue, workflow_id = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
spec = importlib.util.spec_from_file_location("mobile_server_subprocess_under_test", root / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
server.DESKTOP_COMMANDS_PATH = queue
print(json.dumps(server._desktop_commands_pending(workflow_id), ensure_ascii=False))
"""


def command_payload(node_id: object = "16", input_name: object = "标签模式", value: object = True, **extra: object) -> dict:
    body = {"workflow_id": WORKFLOW_ID, "node_id": node_id, "input": input_name, "value": value}
    body.update(extra)
    return body


class DesktopCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop-commands-")
        root = Path(self.temporary.name)
        self.runtime = root / ".runtime"
        self.runtime.mkdir()
        self.workflows = root / "workflows"
        self.workflows.mkdir()
        self.queue_path = self.runtime / "desktop_commands.json"
        self.patches = [
            mock.patch.object(server, "WORKFLOW_ROOT", self.workflows),
            mock.patch.object(server, "DESKTOP_COMMANDS_PATH", self.queue_path),
        ]
        for item in self.patches:
            item.start()
        server._DESKTOP_COMMANDS = None
        self.write_record(WORKFLOW_ID, PROMPT)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        server._DESKTOP_COMMANDS = None
        self.temporary.cleanup()

    def write_record(self, workflow_id: str, prompt: dict, name: str = "测试工作流") -> Path:
        path = self.workflows / f"{workflow_id}.json"
        path.write_text(
            json.dumps({"id": workflow_id, "name": name, "prompt": prompt}, ensure_ascii=False),
            encoding="utf-8",
        )
        return path

    def submit(self, payload: dict):
        return server._desktop_command_submit(payload)

    # ---- 入队 --------------------------------------------------------------

    def test_valid_command_is_queued_with_the_value_untouched(self):
        command, error, status, reason = self.submit(command_payload())
        self.assertEqual((error, status, reason), ("", 200, ""))
        self.assertEqual(command["workflow_id"], WORKFLOW_ID)
        self.assertEqual(command["node_id"], "16")
        self.assertEqual(command["input"], "标签模式")
        self.assertIs(True, command["value"])
        self.assertEqual(len(command["id"]), 32)          # uuid4().hex
        self.assertIsInstance(command["at"], int)

        pending = server._desktop_commands_pending(WORKFLOW_ID)
        self.assertEqual(len(pending), 1)
        # 给电脑端的字段就这四个，不多塞内部信息
        self.assertEqual(set(pending[0]), {"id", "node_id", "input", "value"})
        self.assertEqual(pending[0]["id"], command["id"])
        self.assertEqual(server._desktop_commands_count(), 1)

    def test_numbers_and_strings_are_accepted_under_their_real_shape(self):
        # 高级页的数字框发回来就是字符串，节点号也可能是数字
        command, error, status, _ = self.submit(
            command_payload(node_id=16, input_name="text", value="新文本")
        )
        self.assertEqual((error, status), ("", 200))
        self.assertEqual(command["node_id"], "16")
        self.assertEqual(command["value"], "新文本")
        command, _, _, _ = self.submit(command_payload(input_name="每次随机", value=False))
        self.assertIs(False, command["value"])
        self.assertEqual(server._desktop_commands_count(), 2)

    def test_server_never_touches_the_record_prompt(self):
        path = self.workflows / f"{WORKFLOW_ID}.json"
        before = path.read_text(encoding="utf-8")
        self.submit(command_payload())
        self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_missing_workflow_is_reported(self):
        payload = command_payload()
        payload["workflow_id"] = OTHER_WORKFLOW_ID
        command, error, status, reason = self.submit(payload)
        self.assertIsNone(command)
        self.assertEqual((status, reason), (404, "workflow"))
        self.assertTrue(error)
        self.assertEqual(server._desktop_commands_count(), 0)

    # ---- 校验 --------------------------------------------------------------

    def test_unknown_node_and_input_are_rejected(self):
        cases = (
            (command_payload(node_id="99"), "node"),
            (command_payload(input_name="不存在"), "input"),
            (command_payload(input_name="clip"), "input"),     # 被连线接管的输入不是控件
        )
        for payload, reason in cases:
            with self.subTest(payload=payload):
                command, error, status, got = self.submit(payload)
                self.assertIsNone(command)
                self.assertEqual((status, got), (400, reason))
                self.assertTrue(error)
        self.assertEqual(server._desktop_commands_count(), 0)

    def test_malformed_keys_are_rejected(self):
        long_node = "1" * 70
        long_input = "输" * 129
        for payload in (
            command_payload(node_id=""),
            command_payload(node_id="16 "),
            command_payload(node_id="../etc"),
            command_payload(node_id=long_node),
            command_payload(node_id=True),
            command_payload(node_id=[16]),
            command_payload(node_id=None),
            command_payload(input_name=""),
            command_payload(input_name="标签:模式"),
            command_payload(input_name=long_input),
            command_payload(input_name=16),
            command_payload(input_name=None),
        ):
            with self.subTest(payload=payload):
                command, error, status, reason = self.submit(payload)
                self.assertIsNone(command)
                self.assertEqual((status, reason), (400, "payload"))
                self.assertTrue(error)
        # 合法但不存在的工作流编号形状
        command, _, status, reason = self.submit(command_payload(workflow_id="not-a-workflow-id"))
        self.assertIsNone(command)
        self.assertEqual((status, reason), (400, "workflow"))
        self.assertEqual(server._desktop_commands_count(), 0)

    def test_extra_fields_and_bad_values_are_rejected(self):
        cases = (
            command_payload(extra="x"),
            command_payload(workflow_id=WORKFLOW_ID, ids=["x"]),
            {k: v for k, v in command_payload().items() if k != "value"},
            command_payload(value=[1, 2]),
            command_payload(value={"a": 1}),
            command_payload(value=float("nan")),
            command_payload(value=float("inf")),
            command_payload(value="文" * (server.DESKTOP_COMMAND_VALUE_MAX_LENGTH + 1)),
        )
        for payload in cases:
            with self.subTest(payload=list(payload)[:2]):
                command, error, status, _ = self.submit(payload)
                self.assertIsNone(command)
                self.assertEqual(status, 400)
                self.assertTrue(error)
        # 刚好卡在上限上的长文本照收（高级页的长提示词）
        limit = "文" * server.DESKTOP_COMMAND_VALUE_MAX_LENGTH
        command, error, _, _ = self.submit(command_payload(input_name="text", value=limit))
        self.assertEqual(error, "")
        self.assertEqual(command["value"], limit)
        self.assertEqual(server._desktop_commands_count(), 1)

    def test_non_object_payload_is_rejected(self):
        for payload in (None, [], "x", 3):
            with self.subTest(payload=payload):
                command, error, status, reason = self.submit(payload)
                self.assertIsNone(command)
                self.assertEqual((status, reason), (400, "payload"))
                self.assertTrue(error)

    # ---- 去重与封顶 --------------------------------------------------------

    def test_only_the_latest_command_per_node_and_input_survives(self):
        for value in (True, False, True):
            self.submit(command_payload(value=value))
        pending = server._desktop_commands_pending(WORKFLOW_ID)
        self.assertEqual(len(pending), 1)
        self.assertIs(True, pending[0]["value"])
        self.assertEqual(server._desktop_commands_count(), 1)
        # 同节点不同输入、同输入不同节点互不影响
        self.submit(command_payload(input_name="text", value="a"))
        self.submit(command_payload(node_id="4", input_name="ckpt_name", value="b.safetensors"))
        self.assertEqual(server._desktop_commands_count(), 3)

    def test_queue_keeps_only_the_newest_fifty(self):
        prompt = {"1": {"class_type": "WideNode", "inputs": {f"p{index}": index for index in range(60)}}}
        self.write_record(WORKFLOW_ID, prompt)
        for index in range(60):
            command, error, status, _ = self.submit(command_payload(node_id="1", input_name=f"p{index}", value=index))
            self.assertEqual((error, status), ("", 200), f"p{index}")
        pending = server._desktop_commands_pending(WORKFLOW_ID)
        self.assertEqual(len(pending), server.DESKTOP_COMMANDS_MAX)
        self.assertEqual([item["input"] for item in pending], [f"p{index}" for index in range(10, 60)])
        self.assertEqual(server._desktop_commands_count(), 50)

    # ---- 领取与 ack --------------------------------------------------------

    def test_pending_is_filtered_by_workflow_and_never_deletes(self):
        self.write_record(OTHER_WORKFLOW_ID, PROMPT, name="另一个工作流")
        first, _, _, _ = self.submit(command_payload())
        payload = command_payload(input_name="text", value="另一个工作流的值")
        payload["workflow_id"] = OTHER_WORKFLOW_ID
        second, _, _, _ = self.submit(payload)
        self.assertEqual(server._desktop_commands_count(), 2)

        mine = server._desktop_commands_pending(WORKFLOW_ID)
        self.assertEqual([item["id"] for item in mine], [first["id"]])
        other = server._desktop_commands_pending(OTHER_WORKFLOW_ID)
        self.assertEqual([item["id"] for item in other], [second["id"]])
        # 领两次内容一样：领取不删除，等电脑端 ack
        self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID), mine)
        self.assertEqual(server._desktop_commands_count(), 2)
        self.assertEqual(server._desktop_commands_pending("c" * 20), [])

    def test_ack_deletes_only_the_acked_commands(self):
        first, _, _, _ = self.submit(command_payload())
        second, _, _, _ = self.submit(command_payload(input_name="text", value="x"))
        body, error = server._desktop_commands_ack_payload({"ids": [first["id"]]})
        self.assertEqual(error, "")
        self.assertEqual(body, {"ok": True, "removed": 1, "pending": 1})
        self.assertEqual([item["id"] for item in server._desktop_commands_pending(WORKFLOW_ID)], [second["id"]])
        # 重复 ack 同一条是幂等的
        body, error = server._desktop_commands_ack_payload({"ids": [first["id"]]})
        self.assertEqual((error, body["removed"]), ("", 0))
        body, _ = server._desktop_commands_ack_payload({"ids": [second["id"]]})
        self.assertEqual(body["pending"], 0)
        self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID), [])

    def test_ack_rejects_malformed_payloads(self):
        self.submit(command_payload())
        cases = (None, [], "x", {}, {"ids": "abc"}, {"ids": [1]}, {"ids": [""]}, {"ids": [None]},
                 {"ids": ["x" * 80]}, {"ids": [], "extra": 1},
                 {"ids": [f"i{index}" for index in range(server.DESKTOP_COMMAND_ACK_MAX + 1)]})
        for payload in cases:
            with self.subTest(payload=str(payload)[:60]):
                body, error = server._desktop_commands_ack_payload(payload)
                self.assertIsNone(body)
                self.assertTrue(error)
        # 全被拒，队列一条没少
        self.assertEqual(server._desktop_commands_count(), 1)

    def test_pending_payload_requires_a_well_formed_workflow_id(self):
        self.submit(command_payload())
        for value in ("", "x", None, "A" * 20, "../etc"):
            with self.subTest(value=value):
                body, error = server._desktop_commands_pending_payload(value)
                self.assertIsNone(body)
                self.assertTrue(error)
        body, error = server._desktop_commands_pending_payload(WORKFLOW_ID)
        self.assertEqual(error, "")
        self.assertTrue(body["ok"])
        self.assertEqual(len(body["commands"]), 1)
        self.assertEqual(set(body["commands"][0]), {"id", "node_id", "input", "value"})

    # ---- 落盘与读回 --------------------------------------------------------

    def test_queue_is_persisted_under_runtime_and_read_back(self):
        self.write_record(OTHER_WORKFLOW_ID, PROMPT)
        first, _, _, _ = self.submit(command_payload())
        payload = command_payload(input_name="text", value="另一个")
        payload["workflow_id"] = OTHER_WORKFLOW_ID
        self.submit(payload)

        self.assertTrue(self.queue_path.is_file())
        self.assertEqual(self.queue_path.parent.name, ".runtime")
        stored = json.loads(self.queue_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["schema"], 1)
        self.assertEqual([item["id"] for item in stored["commands"]],
                         [first["id"], server._desktop_commands_pending(OTHER_WORKFLOW_ID)[0]["id"]])
        self.assertEqual(stored["commands"][0]["node_id"], "16")
        self.assertIs(True, stored["commands"][0]["value"])

        # 丢掉内存副本 = 服务重启；同一条记录必须从磁盘读回来
        expected = server._desktop_commands_pending(WORKFLOW_ID)
        server._DESKTOP_COMMANDS = None
        self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID), expected)
        self.assertEqual(server._desktop_commands_count(), 2)

        # 真开一个新进程读同一个文件：待办跨重启不丢
        result = subprocess.run(
            [sys.executable, "-B", "-c", SUBPROCESS_READER, str(ROOT), str(self.queue_path), WORKFLOW_ID],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]), expected)

    def test_broken_queue_file_degrades_to_empty(self):
        self.submit(command_payload())
        for content in ("not json", "[]", "{}", '{"commands": "x"}', '{"commands": [{"id": 1}]}'):
            with self.subTest(content=content):
                self.queue_path.write_text(content, encoding="utf-8")
                server._DESKTOP_COMMANDS = None
                self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID), [])
        # 坏文件不影响继续排队
        command, error, status, _ = self.submit(command_payload())
        self.assertEqual((error, status), ("", 200))
        self.assertEqual(len(server._desktop_commands_pending(WORKFLOW_ID)), 1)
        self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID)[0]["id"], command["id"])

    def test_unwritable_queue_still_queues_in_memory(self):
        # 写盘失败只记一条警告：队列在内存里，电脑端照样领得到，接口不能因此失败。
        with mock.patch.object(server, "_write_json_atomic", side_effect=OSError("disk full")), \
                self.assertLogs(server.LOG, level="WARNING") as logs:
            command, error, status, _ = self.submit(command_payload())
        self.assertIn("desktop command queue not persisted", logs.output[0])
        self.assertEqual((error, status), ("", 200))          # 队列在内存里，电脑端照样领得到
        self.assertEqual(server._desktop_commands_count(), 1)
        self.assertEqual(server._desktop_commands_pending(WORKFLOW_ID)[0]["id"], command["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
