"""更新覆盖/备份/回滚的安全性测试：全程在临时目录里做，不碰真实插件目录。"""
from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_update_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


def _write(root: Path, name: str, text: str) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class ApplyUpdateTests(unittest.TestCase):
    def test_replaces_project_files_and_keeps_personal_data(self):
        with tempfile.TemporaryDirectory(prefix="upd-") as tmp:
            base = Path(tmp)
            target, source, backup = base / "plugin", base / "src", base / "bak"
            _write(target, "server.py", "old")
            _write(target, "web/remote.js", "old")
            _write(target, "mobile_settings.json", "PERSONAL")
            _write(target, "workflows/w.json", "PERSONAL")
            _write(source, "server.py", "new")
            _write(source, "web/remote.js", "new")
            _write(source, "mobile_tag_node.py", "brand new")
            result = server._apply_update_files(source, target, backup)
            self.assertTrue(result["ok"])
            self.assertEqual((target / "server.py").read_text(encoding="utf-8"), "new")
            self.assertEqual((target / "web/remote.js").read_text(encoding="utf-8"), "new")
            self.assertTrue((target / "mobile_tag_node.py").is_file())
            # 个人数据原样保留
            self.assertEqual((target / "mobile_settings.json").read_text(encoding="utf-8"), "PERSONAL")
            self.assertEqual((target / "workflows/w.json").read_text(encoding="utf-8"), "PERSONAL")
            # 备份里有改动前的旧内容
            self.assertEqual((backup / "server.py").read_text(encoding="utf-8"), "old")

    def test_rollback_restores_files_when_copy_fails(self):
        with tempfile.TemporaryDirectory(prefix="upd-fail-") as tmp:
            base = Path(tmp)
            target, source, backup = base / "plugin", base / "src", base / "bak"
            _write(target, "server.py", "old-1")
            _write(target, "web/remote.js", "old-2")
            _write(source, "server.py", "new-1")
            _write(source, "web/remote.js", "new-2")
            _write(source, "extra.py", "new-3")
            real_copy = shutil.copy2
            calls = {"n": 0}

            def flaky(src, dst, *args, **kwargs):
                calls["n"] += 1
                if calls["n"] == 3:  # 备份 2 个之后、复制到第 3 次时炸
                    raise OSError("disk full")
                return real_copy(src, dst, *args, **kwargs)

            with mock.patch.object(server.shutil, "copy2", side_effect=flaky):
                result = server._apply_update_files(source, target, backup)
            self.assertFalse(result["ok"])
            self.assertTrue(result["restored"])
            # 两个原文件都被还原
            self.assertEqual((target / "server.py").read_text(encoding="utf-8"), "old-1")
            self.assertEqual((target / "web/remote.js").read_text(encoding="utf-8"), "old-2")

    def test_skip_list_covers_personal_data(self):
        for name in ("mobile_settings.json", "workflows", "favorite_files", "drafts", ".runtime", "mobile_history.json"):
            self.assertIn(name, server.UPDATE_SKIP_NAMES)


    def test_stale_project_files_are_removed_but_personal_data_is_safe(self):
        with tempfile.TemporaryDirectory(prefix="upd-stale-") as tmp:
            base = Path(tmp)
            target, source, backup = base / "plugin", base / "src", base / "bak"
            _write(target, "server.py", "old")
            _write(target, "web/removed.js", "gone in new version")
            _write(target, "mobile_settings.json", "PERSONAL")
            _write(target, "workflows/keep.json", "PERSONAL")
            _write(source, "server.py", "new")
            _write(source, "web/remote.js", "new")
            result = server._apply_update_files(source, target, backup)
            self.assertTrue(result["ok"])
            self.assertFalse((target / "web/removed.js").exists())
            self.assertEqual(result["removed"], ["web/removed.js"])
            self.assertEqual((target / "mobile_settings.json").read_text(encoding="utf-8"), "PERSONAL")
            self.assertEqual((target / "workflows/keep.json").read_text(encoding="utf-8"), "PERSONAL")

    def test_backup_pruning_keeps_only_recent(self):
        with tempfile.TemporaryDirectory(prefix="upd-prune-") as tmp:
            runtime = Path(tmp) / ".runtime"
            for name in ("backup-20260101-000000", "backup-20260102-000000", "backup-20260103-000000"):
                (runtime / name).mkdir(parents=True)
            (runtime / "backup-20260103-000000" / "server.py").write_text("x", encoding="utf-8")
            with mock.patch.object(server, "PLUGIN_ROOT", Path(tmp)):
                removed = server._prune_backups()
            self.assertEqual(removed, 1)
            left = sorted(p.name for p in runtime.glob("backup-*"))
            self.assertEqual(left, ["backup-20260102-000000", "backup-20260103-000000"])


if __name__ == "__main__":
    unittest.main()
