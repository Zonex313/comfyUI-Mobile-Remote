"""Isolated server data-policy tests; no ComfyUI queue, GPU, or real media files."""
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
spec = importlib.util.spec_from_file_location("mobile_server_policy_under_test", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)


class ServerPolicyTests(unittest.TestCase):
    def test_detail_allowlist_keeps_scalars_and_drops_graph_extras(self):
        job = {
            "id": "job-1",
            "workflow": {"prompt": {"3": {"class_type": "KSampler", "inputs": {
                "vae_name": "vae.safetensors", "sampler_name": "euler", "scheduler": "normal",
                "batch_size": 2, "prompt": ["secret", 0], "raw_graph": {"secret": True},
            }}}},
            "outputs": {"secret": True},
            "execution_error": {"type": "execution_error", "data": {"traceback": "secret"}},
        }
        result = server._sanitize_job_detail(job)
        inputs = result["workflow"]["prompt"]["3"]["inputs"]
        self.assertEqual({"vae_name", "sampler_name", "scheduler", "batch_size"}, set(inputs))
        self.assertNotIn("outputs", result)
        self.assertEqual(result["execution_error"], {"type": "execution_error", "data": {}})

    def test_favorite_meta_is_written_next_to_the_image(self):
        with tempfile.TemporaryDirectory(prefix="mobile-fav-write-") as root:
            job_id = "job-meta-write"
            folder = Path(root) / job_id
            folder.mkdir()
            (folder / "kept.png").write_bytes(b"x")
            entry = {"prompt": [0, job_id, {}, {"create_time": 99, "mobile_remote": {
                "workflow_name": "Krea", "preset": {"enabled": True, "prompt": "a cat"},
            }}], "status": {}}
            with mock.patch.object(server, "FAVORITE_FILES", Path(root)), \
                    mock.patch.object(server, "_history_entry_for_favorite", return_value=entry):
                server._write_favorite_meta(job_id)
            meta = json.loads((folder / "job.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["workflow_name"], "Krea")
            self.assertEqual(meta["preset"]["prompt"], "a cat")
            self.assertEqual(meta["create_time"], 99)

    def test_preview_webp_is_smaller_than_source(self):
        from PIL import Image
        with tempfile.TemporaryDirectory(prefix="mobile-preview-") as root:
            path = Path(root) / "big.png"
            Image.new("RGB", (640, 640), "red").save(path)
            body = server._preview_webp_bytes(path, 64)
            self.assertTrue(body.startswith(b"RIFF"))
            self.assertLess(len(body), path.stat().st_size)

    def test_favorite_disk_skips_workflow_sidecar(self):
        with tempfile.TemporaryDirectory(prefix="mobile-fav-meta-") as root:
            job_id = "job-meta"
            folder = Path(root) / job_id
            folder.mkdir()
            (folder / "kept.png").write_bytes(b"x")
            (folder / "job.json").write_text("{}", encoding="utf-8")
            (folder / "job.json.abc.tmp").write_text("{}", encoding="utf-8")
            with mock.patch.object(server, "FAVORITE_FILES", Path(root)):
                self.assertEqual(server._favorite_disk_files(job_id), ["kept.png"])
                self.assertFalse((folder / "job.json.abc.tmp").exists())

    def test_history_gallery_keeps_favorite_copy_after_output_filename_reuse(self):
        with tempfile.TemporaryDirectory(prefix="mobile-fav-copy-") as root:
            job_id = "job-fav"
            dest = Path(root) / job_id
            dest.mkdir()
            (dest / "kept.png").write_bytes(b"x")
            history_item = {
                "outputs": {"9": {"images": [{"filename": "new.png", "subfolder": "Krea2", "type": "output"}]}},
                "status": {},
            }
            with mock.patch.object(server, "_media_item_fresh", return_value=False), \
                    mock.patch.object(server, "_favorites_for_job", return_value=[]), \
                    mock.patch.object(server, "_favorite_disk_files", return_value=["kept.png"]), \
                    mock.patch.object(server, "_favorite_file_path", side_effect=lambda _job, name: dest / name), \
                    mock.patch.object(server, "_ensure_favorite_copy", return_value=None), \
                    mock.patch.object(server, "_is_favorite", return_value=False):
                gallery = server._history_gallery(history_item, job_id)
            self.assertEqual([item["filename"] for item in gallery], ["kept.png"])
            self.assertEqual(gallery[0]["source"], "favorite")
            self.assertTrue(gallery[0]["favorite"])

    def test_history_keeps_newest_five_hundred_and_older_favorites(self):
        items = [(f"job-{index}", {"prompt": [0, None, {}, {"create_time": index}]}) for index in range(1, 521)]
        pinned = {f"job-{index}" for index in range(1, 15)}
        kept_items = server._keep_newest_plus_pins(items, pinned, 500, server._history_entry_time)
        kept = {key for key, _item in kept_items}
        self.assertEqual(len(kept), 514)
        self.assertTrue(pinned <= kept)
        self.assertNotIn("job-15", kept)
        self.assertIn("job-21", kept)
        self.assertIn("job-520", kept)

    def test_favoriting_newest_jobs_does_not_expand_history_core(self):
        items = [(f"job-{index}", {"prompt": [0, None, {}, {"create_time": index}]}) for index in range(1, 521)]
        pinned = {f"job-{index}" for index in range(506, 521)}
        kept_items = server._keep_newest_plus_pins(items, pinned, 500, server._history_entry_time)
        kept = {key for key, _item in kept_items}
        self.assertEqual(len(kept), 500)
        self.assertTrue(pinned <= kept)
        self.assertNotIn("job-20", kept)
        jobs = [{"id": key, "status": "completed", "create_time": index}
                for index, (key, _item) in enumerate(kept_items, start=1)]
        marked = server._mark_favorite_extra(jobs, 500)
        self.assertFalse(any(job.get("favorite_extra") for job in marked))

    def test_summary_never_contains_workflow_graph(self):
        result = server._mobile_job_summary({
            "id": "job-1", "workflow": {"prompt": {"secret": {}}}, "preview_output": None,
            "status": "completed", "workflow_name": "fixture",
        })
        self.assertNotIn("workflow", result)
        self.assertEqual(result["id"], "job-1")

    def test_media_ownership_requires_history_output_even_when_favorited(self):
        fake_queue = types.SimpleNamespace(get_history=lambda: {})
        fake_server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=fake_queue)))
        with tempfile.TemporaryDirectory(prefix="mobile-server-policy-") as root:
            folder_paths = types.SimpleNamespace(get_directory_by_type=lambda _kind: root)
            old_server = sys.modules.get("server")
            old_folder_paths = sys.modules.get("folder_paths")
            sys.modules["server"] = fake_server
            sys.modules["folder_paths"] = folder_paths
            try:
                with mock.patch.object(server, "_load_favorites", return_value=None), \
                        mock.patch.object(server, "_media_item_fresh", return_value=True):
                    self.assertFalse(server._media_belongs_to_job_without_favorites(
                        "job-1", "image.png", "", "output"))
            finally:
                if old_server is None:
                    sys.modules.pop("server", None)
                else:
                    sys.modules["server"] = old_server
                if old_folder_paths is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = old_folder_paths


if __name__ == "__main__":
    unittest.main(verbosity=2)
