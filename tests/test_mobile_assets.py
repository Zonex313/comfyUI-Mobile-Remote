"""手机端引用的静态资源必须都在 /mobile/assets/ 白名单里。

踩过的坑：新增 advanced.js/advanced.css 后忘了加进 _MOBILE_ASSET_FILES，
浏览器取不到（404），「高级」页整块空白；而浏览器测试用的是自带夹具服务器，
绕过白名单，完全测不出来。所以这条检查必须放在服务端测试里。
"""
from __future__ import annotations

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_assets_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

ASSET_RE = re.compile(r"/mobile/assets/([A-Za-z0-9_.-]+)")


class MobileAssetTests(unittest.TestCase):
    def test_every_referenced_asset_is_whitelisted(self):
        served = set(server._MOBILE_ASSET_FILES) | set(server._SHARED_ASSET_FILES)
        missing: list[str] = []
        sources = [ROOT / "mobile" / "index.html", *sorted((ROOT / "mobile").glob("*.js"))]
        for file in sources:
            for name in ASSET_RE.findall(file.read_text(encoding="utf-8")):
                if name not in served:
                    missing.append(f"{file.name} -> {name}")
        self.assertEqual(missing, [], f"这些资源不在白名单里，浏览器会 404：{missing}")

    def test_whitelisted_assets_exist_on_disk(self):
        for name in server._MOBILE_ASSET_FILES:
            path = server._SHARED_ASSET_FILES.get(name) or (ROOT / "mobile" / name)
            self.assertTrue(path.is_file(), f"{name} 在白名单里但文件不存在：{path}")

    def test_assets_are_reachable_through_the_public_tunnel(self):
        """公网隧道走的是另一份白名单（connections.GET_PATHS），也漏过一次。"""
        import re as _re
        text = (ROOT / "connections.py").read_text(encoding="utf-8")
        match = _re.search(r"GET_PATHS = \((.*?)\)\n", text, _re.S)
        self.assertIsNotNone(match, "connections.py 里找不到 GET_PATHS")
        pattern = "|".join(_re.findall(r'"(.*?)"', match.group(1)))
        compiled = _re.compile(pattern)
        missing = [name for name in sorted(set(server._MOBILE_ASSET_FILES)) if not compiled.search("/mobile/assets/" + name)]
        self.assertEqual(missing, [], f"这些资源过不了公网隧道白名单：{missing}")

    def test_desktop_command_route_is_tunnel_safe(self):
        """手机改节点设置要能过公网隧道，但确认接口(ack)绝不能暴露。"""
        import re as _re
        text = (ROOT / "connections.py").read_text(encoding="utf-8")
        match = _re.search(r"POST_PATHS = \((.*?)\n\)", text, _re.S)
        self.assertIsNotNone(match, "connections.py 里找不到 POST_PATHS")
        pattern = "|".join(_re.findall(r'"(.*?)"', match.group(1)))
        compiled = _re.compile(pattern)
        self.assertTrue(compiled.match("/mobile/api/desktop/commands"), "桌面指令接口没放行，隧道用户改不动节点")
        self.assertFalse(compiled.match("/mobile/api/desktop/commands/ack"), "ack 接口被暴露到公网了")

    def test_advanced_page_assets_are_served(self):
        # 「高级」页依赖这两个文件，漏一个就是整页空白
        self.assertIn("advanced.js", server._MOBILE_ASSET_FILES)
        self.assertIn("advanced.css", server._MOBILE_ASSET_FILES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
