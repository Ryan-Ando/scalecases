"""Tests for the creative library helper (python -m unittest test_library_helper)."""
import json, os, shutil, socket, tempfile, unittest, urllib.error, urllib.request
import library_helper

ORIGIN = "https://scalecases-client.onrender.com"


def fixture():
    parent = tempfile.mkdtemp(prefix="scalecases-library-")
    root = os.path.join(parent, "2026 B2C")
    os.makedirs(os.path.join(root, "0901")); os.makedirs(os.path.join(root, "CO"))
    open(os.path.join(root, "0901", "0901-Notes-1-img.png"), "w").write("fake-image")
    open(os.path.join(root, "CO", "0901-Notes-1-img-LSS CO.png"), "w").write("fake-variant")
    open(os.path.join(root, "0901", "voice.mp3"), "w").write("ignore")
    return parent, root


def get(url, origin=None, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"Origin": origin} if origin else {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


class LibraryHelperTest(unittest.TestCase):
    def test_scanner_handles_date_and_state_folders_and_ignores_audio(self):
        parent, root = fixture(); self.addCleanup(shutil.rmtree, parent)
        base, files, _ = library_helper.scan_library(root)
        self.assertEqual(len(files), 2)
        self.assertEqual(files[1]["state"], "CO"); self.assertEqual(files[1]["date"], "2026-09-01")
        self.assertFalse(any(root in f["relativePath"] for f in files))
        # same ids as the old Node helper: sha256 of the relative path, 24 hex chars
        self.assertEqual(files[0]["id"], library_helper.hashlib.sha256(b"0901/0901-Notes-1-img.png").hexdigest()[:24])

    def test_helper_restricts_origins_hides_paths_and_notices_new_files(self):
        parent, root = fixture(); self.addCleanup(shutil.rmtree, parent)
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()   # a free port
        lib = library_helper.Library(lambda: root, [ORIGIN], port=port, interval=600)
        server = lib.start(); self.addCleanup(server.shutdown)
        lib.scan()   # the first scan runs in the background; don't race it
        base = f"http://127.0.0.1:{lib.port}"
        self.assertEqual(get(base + "/manifest")[0], 403)
        self.assertEqual(get(base + "/manifest", "https://other.example")[0], 403)
        manifest = json.loads(get(base + "/manifest", ORIGIN)[1])
        self.assertEqual(len(manifest["files"]), 2); self.assertIsNone(manifest["error"])
        self.assertEqual(get(f"{base}/preview/{manifest['files'][0]['id']}", ORIGIN)[1], b"fake-image")
        self.assertEqual(get(base + "/preview/../../config.json", ORIGIN)[0], 404)
        self.assertEqual(get(base + "/manifest", ORIGIN, "POST")[0], 405)
        open(os.path.join(root, "0901", "0901-new.mp4"), "w").write("video")
        lib.scan()
        self.assertEqual(len(json.loads(get(base + "/manifest", ORIGIN)[1])["files"]), 3)


if __name__ == "__main__":
    unittest.main()
