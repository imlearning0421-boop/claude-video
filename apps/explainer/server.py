#!/usr/bin/env python3
"""Explainer-video app: a small local web server.

    python3 apps/explainer/server.py            # then open http://localhost:8765

Endpoints
    GET  /                  the app (static/)
    GET  /api/status        {"engine": "claude" | "offline", "mp4": bool}
    POST /api/storyboard    {"input", "language", "seconds"} -> storyboard JSON
    POST /api/mp4           body: a WebM recording -> MP4 (needs ffmpeg)
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
sys.path.insert(0, str(HERE))

import storyboard  # noqa: E402

MAX_JSON_BYTES = 1_000_000
MAX_VIDEO_BYTES = 500_000_000


def webm_to_mp4(data: bytes) -> bytes:
    """Convert a browser WebM recording to an H.264/AAC MP4 with ffmpeg."""
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.webm", Path(tmp) / "out.mp4"
        src.write_bytes(data)
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(dst),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if result.returncode != 0 or not dst.exists():
            raise RuntimeError(result.stderr.strip() or "ffmpeg failed")
        return dst.read_bytes()


class Handler(BaseHTTPRequestHandler):
    server_version = "Explainer/1.0"

    def log_message(self, fmt, *args):  # quieter console
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _body(self, limit: int) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            self._json(413 if length > limit else 400, {"error": "Request body is missing or too large."})
            return None
        return self.rfile.read(length)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            self._json(200, {
                "engine": "claude" if storyboard.has_claude_credentials() else "offline",
                "mp4": shutil.which("ffmpeg") is not None,
                "model": storyboard.MODEL,
            })
            return
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents or not target.is_file():
            self._json(404, {"error": "Not found"})
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/storyboard":
            body = self._body(MAX_JSON_BYTES)
            if body is None:
                return
            try:
                req = json.loads(body.decode("utf-8"))
                result = storyboard.make_storyboard(
                    req.get("input", ""), req.get("language", "english"), req.get("seconds", 60),
                    use_claude=None if not req.get("offline") else False,
                )
            except (ValueError, AttributeError):
                self._json(400, {"error": "Send JSON like {\"input\": \"Photosynthesis\"}."})
                return
            except storyboard.StoryboardError as exc:
                self._json(422, {"error": str(exc)})
                return
            self._json(200, result)
            return
        if path == "/api/mp4":
            if not shutil.which("ffmpeg"):
                self._json(501, {"error": "ffmpeg is not installed on the server."})
                return
            body = self._body(MAX_VIDEO_BYTES)
            if body is None:
                return
            try:
                mp4 = webm_to_mp4(body)
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": f"MP4 conversion failed: {exc}"})
                return
            self._send(200, mp4, "video/mp4", {"Content-Disposition": 'attachment; filename="explainer.mp4"'})
            return
        self._json(404, {"error": "Not found"})


def make_server(host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the explainer-video app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = make_server(args.host, args.port)
    engine = "Claude (" + storyboard.MODEL + ")" if storyboard.has_claude_credentials() else \
        "offline demo (set ANTHROPIC_API_KEY and `pip install anthropic` for Claude)"
    print(f"Explainer video app → http://{args.host}:{args.port}\nStoryboards by: {engine}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
