"""界面多语言的服务端行为：词典查找、占位符代入、语言判定与降级。"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mobile_server_i18n_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class LocaleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="i18n-")
        self.root = Path(self._tmp.name)
        self._original = server.I18N_ROOT
        server.I18N_ROOT = self.root
        server._locale_catalog.cache_clear()
        self.addCleanup(self._restore)

    def _restore(self):
        server.I18N_ROOT = self._original
        server._locale_catalog.cache_clear()
        self._tmp.cleanup()

    def _catalog(self, lang: str, payload: dict) -> None:
        (self.root / f"{lang}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        server._locale_catalog.cache_clear()

    def test_chinese_needs_no_dictionary(self):
        self.assertEqual(server._locale_catalog("zh"), {})
        self.assertEqual(server._t("设置"), "设置")

    def test_translates_with_the_request_language(self):
        self._catalog("en", {"设置": "Settings"})
        token = server._REQUEST_LANG.set("en")
        try:
            self.assertEqual(server._t("设置"), "Settings")
        finally:
            server._REQUEST_LANG.reset(token)

    def test_missing_catalog_entry_falls_back_to_chinese(self):
        self._catalog("en", {"设置": "Settings"})
        token = server._REQUEST_LANG.set("en")
        try:
            self.assertEqual(server._t("没有翻译过的文案"), "没有翻译过的文案")
        finally:
            server._REQUEST_LANG.reset(token)

    def test_placeholders_are_substituted_from_the_translation(self):
        self._catalog("en", {"{label} 内容过长": "{label} is too long"})
        token = server._REQUEST_LANG.set("en")
        try:
            self.assertEqual(server._t("{label} 内容过长", label="Prompt"), "Prompt is too long")
        finally:
            server._REQUEST_LANG.reset(token)

    def test_broken_translation_never_raises(self):
        # 译文里的花括号写坏了也不能让接口 500：退回中文原文。
        self._catalog("en", {"{label} 内容过长": "{label is too long"})
        token = server._REQUEST_LANG.set("en")
        try:
            self.assertEqual(server._t("{label} 内容过长", label="Prompt"), "{label} 内容过长")
        finally:
            server._REQUEST_LANG.reset(token)

    def test_accept_language_picks_the_first_supported_tag(self):
        self.assertEqual(server._accept_language("fr-FR,fr;q=0.9,ja;q=0.8"), "ja")
        self.assertEqual(server._accept_language("ko-KR,ko;q=0.9"), "ko")
        self.assertEqual(server._accept_language("en_US"), "en")
        self.assertEqual(server._accept_language("de-DE,de;q=0.9"), "zh")
        self.assertEqual(server._accept_language(""), "zh")

    def test_request_locale_prefers_the_cookie(self):
        class Request:
            cookies = {server.LOCALE_COOKIE: "ja"}
            headers = {"Accept-Language": "en-US,en;q=0.9"}

        self.assertEqual(server._request_locale(Request()), "ja")

    def test_request_locale_falls_back_to_the_browser(self):
        class Request:
            cookies: dict = {}
            headers = {"Accept-Language": "en-US,en;q=0.9"}

        self.assertEqual(server._request_locale(Request()), "en")

    def test_locale_response_rejects_unknown_languages(self):
        with self.assertRaises(web.HTTPNotFound):
            server._locale_response("de")
        with self.assertRaises(web.HTTPNotFound):
            server._locale_response("../../server")

    def test_locale_response_serves_zh_as_empty_and_en_from_disk(self):
        self._catalog("en", {"设置": "Settings"})
        self.assertEqual(server._locale_response("zh").status, 200)
        self.assertEqual(server._locale_response("en").status, 200)

    def test_missing_dictionary_file_is_a_404(self):
        with self.assertRaises(web.HTTPNotFound):
            server._locale_response("ja")

    def test_shared_runtime_is_served_next_to_the_phone_assets(self):
        # 手机页和电脑端面板加载的必须是同一份实现。
        response = server._asset_response("i18n.js")
        self.assertEqual(Path(response._path).resolve(), (ROOT / "web" / "i18n.js").resolve())


class MiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_middleware_binds_and_restores_the_language(self):
        seen = {}

        async def handler(request):
            seen["lang"] = server._REQUEST_LANG.get()
            return web.Response(text="ok")

        class Request:
            cookies = {server.LOCALE_COOKIE: "ko"}
            headers: dict = {}

        response = await server._locale_middleware(Request(), handler)
        self.assertEqual(response.status, 200)
        self.assertEqual(seen["lang"], "ko")
        self.assertEqual(server._REQUEST_LANG.get(), "zh")

