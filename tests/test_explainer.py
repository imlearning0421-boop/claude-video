"""Explainer-video app (apps/explainer): storyboard building and the local server."""
from __future__ import annotations

import json
import sys
import threading
import types
import urllib.error
import urllib.request
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "apps" / "explainer"
sys.path.insert(0, str(APP_DIR))

import storyboard  # noqa: E402
import server  # noqa: E402


def test_classify_input():
    assert storyboard.classify_input("https://example.com/a?b=1") == "url"
    assert storyboard.classify_input("Photosynthesis") == "topic"
    assert storyboard.classify_input("line one\nline two") == "text"
    assert storyboard.classify_input("x" * 200) == "text"


def test_html_to_text_drops_scripts_and_keeps_blocks():
    title, text = storyboard.html_to_text(
        "<html><head><title>Rain &amp; Light</title><style>p{}</style></head>"
        "<body><nav>Menu</nav><h1>Rainbows</h1><p>Light   bends.</p><script>x()</script><p>Colours split.</p></body></html>"
    )
    assert title == "Rain & Light"
    assert text.splitlines() == ["Rainbows", "Light bends.", "Colours split."]


def test_build_source_rejects_empty_input():
    with pytest.raises(storyboard.StoryboardError):
        storyboard.build_source("   ")


def test_normalize_repairs_scenes_the_renderer_cannot_draw():
    board = storyboard.normalize({
        "title": "T", "palette": "not-a-palette",
        "scenes": [
            {"type": "stat", "heading": "No number", "value": "", "duration": 50},
            {"type": "comparison", "heading": "One side", "items": [{"emoji": "A", "text": "only"}]},
            {"type": "bullets", "heading": "Many", "items": [{"emoji": "", "text": str(i)} for i in range(9)]},
            {"type": "mystery", "heading": "?", "items": []},
        ],
    })
    kinds = [s["type"] for s in board["scenes"]]
    assert kinds == ["quote", "bullets", "bullets", "quote"]
    assert board["palette"] == "sunset"
    assert board["scenes"][0]["duration"] == 10.0
    assert len(board["scenes"][2]["items"]) == 4


def test_normalize_rejects_empty_storyboard():
    with pytest.raises(storyboard.StoryboardError):
        storyboard.normalize({"scenes": []})


@pytest.mark.parametrize("raw", [
    "How rainbows form",
    "Rainbows appear when sunlight enters raindrops. The light bends and splits into colours. "
    "About 7 colours are visible. Red is on the outside. Violet is on the inside. You need the sun behind you.",
])
def test_offline_storyboard_is_well_formed(raw):
    result = storyboard.make_storyboard(raw, "english", 60, use_claude=False)
    board = result["storyboard"]
    assert result["engine"] == "offline"
    assert board["scenes"][0]["type"] == "title"
    assert board["scenes"][-1]["type"] == "outro"
    for scene in board["scenes"]:
        assert scene["type"] in storyboard.SCENE_TYPES
        assert 3.5 <= scene["duration"] <= 10


def test_claude_request_uses_structured_output(monkeypatch):
    anthropic = pytest.importorskip("anthropic")
    captured = {}
    reply = {
        "title": "Rainbows", "palette": "ocean",
        "scenes": [{"type": "title", "heading": "Rainbows", "subheading": "Light, bent", "emoji": "🌈",
                    "items": [], "value": "", "narration": "Hi.", "duration": 5}],
    }

    class Stream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return types.SimpleNamespace(stop_reason="end_turn",
                                         content=[types.SimpleNamespace(type="text", text=json.dumps(reply))])

    def stream(**kwargs):
        captured.update(kwargs)
        return Stream()

    client = types.SimpleNamespace(beta=types.SimpleNamespace(messages=types.SimpleNamespace(stream=stream)))
    source = storyboard.build_source("How rainbows form")
    board = storyboard.generate_with_claude(source, "hinglish", 60, client=client)
    assert board["palette"] == "ocean"
    assert captured["model"] == storyboard.MODEL
    assert captured["output_config"]["format"]["schema"] == storyboard.STORYBOARD_SCHEMA
    assert "Hinglish" in captured["messages"][0]["content"]
    assert anthropic  # imported only to gate the test


def test_claude_refusal_is_reported(monkeypatch):
    pytest.importorskip("anthropic")

    class Stream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return types.SimpleNamespace(stop_reason="refusal", content=[])

    client = types.SimpleNamespace(beta=types.SimpleNamespace(messages=types.SimpleNamespace(stream=lambda **k: Stream())))
    with pytest.raises(storyboard.StoryboardError, match="declined"):
        storyboard.generate_with_claude(storyboard.build_source("x"), "english", 60, client=client)


@pytest.fixture
def running_server(monkeypatch):
    monkeypatch.setenv("EXPLAINER_OFFLINE", "1")
    httpd = server.make_server("127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.status, json.loads(res.read())


def test_server_serves_app_and_storyboards(running_server):
    with urllib.request.urlopen(running_server + "/", timeout=10) as res:
        assert b"Explainer Studio" in res.read()
    with urllib.request.urlopen(running_server + "/api/status", timeout=10) as res:
        assert json.loads(res.read())["engine"] == "offline"
    status, body = _post(running_server + "/api/storyboard", {"input": "Volcanoes", "language": "hindi"})
    assert status == 200 and body["storyboard"]["scenes"]


def test_server_reports_bad_input(running_server):
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(running_server + "/api/storyboard", {"input": ""})
    assert err.value.code == 422


def test_server_blocks_path_traversal(running_server):
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(running_server + "/../server.py", timeout=10)
    assert err.value.code == 404
