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
import tts  # noqa: E402


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
        "title": "T",
        "cast": [{"id": "Amit!", "name": "Amit", "gender": "female", "beard": True, "hair": "mohawk"}],
        "scenes": [
            {"visual": "two_characters", "character": "amit", "other_character": "amit", "narration": "Hi"},
            {"visual": "photo", "character": "Amit", "narration": "Old days"},
            {"visual": "phone", "phone": {"screen": "chat", "messages": []}, "narration": "Text"},
            {"visual": "mystery", "speaker": "Amit", "narration": "Kya baat hai", "highlight": ["baat", "absent"]},
            {"visual": "character", "narration": ""},
        ],
    })
    amit = board["cast"][0]
    assert amit["id"] == "amit" and amit["beard"] is False and amit["hair"] == "long"
    assert [s["visual"] for s in board["scenes"]] == ["character", "character", "phone", "character"]
    assert board["scenes"][2]["phone"]["screen"] == "card"
    assert board["scenes"][3]["speaker"] == "amit"
    assert board["scenes"][3]["highlight"] == ["baat"]
    assert all(2.2 <= s["duration"] <= 9 for s in board["scenes"])


def test_normalize_invents_a_cast_when_missing():
    board = storyboard.normalize({"scenes": [{"visual": "character", "narration": "Hello there"}]})
    assert board["cast"] and board["scenes"][0]["character"] == board["cast"][0]["id"]


def test_normalize_rejects_empty_storyboard():
    with pytest.raises(storyboard.StoryboardError):
        storyboard.normalize({"scenes": []})


@pytest.mark.parametrize("raw", [
    "How rainbows form",
    "Rainbows appear when sunlight enters raindrops. The light bends and splits into colours. "
    "About 7 colours are visible. Red is on the outside. Violet is on the inside. You need the sun behind you.",
])
@pytest.mark.parametrize("language", ["english", "hinglish"])
def test_offline_storyboard_is_well_formed(raw, language):
    result = storyboard.make_storyboard(raw, language, 60, use_claude=False)
    board = result["storyboard"]
    assert result["engine"] == "offline"
    assert board["language"] == language
    assert board["scenes"][-1]["visual"] == "lesson"
    ids = {c["id"] for c in board["cast"]}
    for scene in board["scenes"]:
        assert scene["visual"] in storyboard.VISUALS
        assert scene["character"] in ids
        assert scene["narration"]


def test_schema_marks_every_field_required():
    def walk(node):
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            for child in node["properties"].values():
                walk(child)
        elif node.get("type") == "array":
            walk(node["items"])
    walk(storyboard.STORYBOARD_SCHEMA)


def test_claude_request_uses_structured_output(monkeypatch):
    anthropic = pytest.importorskip("anthropic")
    captured = {}
    reply = {
        "title": "Rainbows",
        "cast": [{"id": "meera", "name": "Meera", "gender": "female", "skin": "light", "hair": "bun",
                  "beard": False, "outfit": "saree", "color": "pink"}],
        "scenes": [{"visual": "character", "setting": "home", "character": "meera", "other_character": "",
                    "other_setting": "home", "pose": "happy", "speaker": "meera", "narration": "Baarish ke baad!",
                    "highlight": ["Baarish"], "phone": {}, "lesson": {"book": "", "heading": ""}}],
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
    assert board["cast"][0]["outfit"] == "saree"
    assert board["scenes"][0]["speaker"] == "meera"
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


# ------------------------------------------------------------------ voice-over


@pytest.fixture
def no_tts_keys(monkeypatch):
    for key in ("ELEVENLABS_API_KEY", "OPENAI_API_KEY", "EXPLAINER_VOICE_NARRATOR",
                "EXPLAINER_VOICE_MALE", "EXPLAINER_VOICE_FEMALE"):
        monkeypatch.delenv(key, raising=False)
    tts._CACHE.clear()


class _Reply:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *a):
        return self.body


def test_tts_provider_prefers_elevenlabs(no_tts_keys, monkeypatch):
    assert tts.provider() is None
    monkeypatch.setenv("OPENAI_API_KEY", "x")
    assert tts.provider() == "openai"
    monkeypatch.setenv("ELEVENLABS_API_KEY", "y")
    assert tts.provider() == "elevenlabs"


def test_tts_without_key_raises(no_tts_keys):
    with pytest.raises(tts.VoiceError, match="No text-to-speech key"):
        tts.speak("Namaste")


def test_tts_elevenlabs_request_and_cache(no_tts_keys, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "secret")
    monkeypatch.setenv("EXPLAINER_VOICE_FEMALE", "voice-f")
    calls = []

    def fake_urlopen(req, timeout):
        calls.append(req)
        return _Reply(b"ID3" + b"\0" * 200)

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    audio = tts.speak("  Yaar,   chhutti nahi mili ", role="female", language="hinglish")
    tts.speak("Yaar, chhutti nahi mili", role="female", language="hinglish")
    assert audio.startswith(b"ID3") and len(calls) == 1
    req = calls[0]
    assert "/text-to-speech/voice-f" in req.full_url
    assert req.get_header("Xi-api-key") == "secret"
    body = json.loads(req.data)
    assert body["text"] == "Yaar, chhutti nahi mili" and body["model_id"] == tts.ELEVENLABS_MODEL


def test_tts_openai_request(no_tts_keys, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    seen = {}

    def fake_urlopen(req, timeout):
        seen["req"] = req
        return _Reply(b"\xff\xfb" + b"\0" * 200)

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    tts.speak("Agle din phone aaya.", role="male", language="hinglish")
    body = json.loads(seen["req"].data)
    assert seen["req"].full_url.endswith("/v1/audio/speech")
    assert seen["req"].get_header("Authorization") == "Bearer sk-test"
    assert body["voice"] == tts.OPENAI_VOICES["male"] and "Hinglish" in body["instructions"]


def test_tts_rejected_key_message(no_tts_keys, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "bad")

    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(tts.VoiceError, match="rejected"):
        tts.speak("Hello")


def test_server_voice_endpoint(running_server, no_tts_keys, monkeypatch):
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(running_server + "/api/voice", {"text": "Hi"})
    assert err.value.code == 501
    monkeypatch.setattr(tts, "provider", lambda: "fake")
    monkeypatch.setattr(tts, "speak", lambda text, role, language: b"ID3fake-audio")
    req = urllib.request.Request(running_server + "/api/voice", data=json.dumps({"text": "Hi"}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        assert res.headers["Content-Type"] == "audio/mpeg" and res.read() == b"ID3fake-audio"


def test_tts_retries_when_busy(no_tts_keys, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.setattr(tts.time, "sleep", lambda s: None)
    attempts = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        if len(attempts) < 3:
            raise urllib.error.HTTPError(req.full_url, 429, "busy", {}, None)
        return _Reply(b"ID3" + b"\0" * 200)

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    assert tts.speak("Phir se").startswith(b"ID3") and len(attempts) == 3


def test_tts_paid_voice_message(no_tts_keys, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")

    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 402, "pay", {}, None)

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(tts.VoiceError, match="paid"):
        tts.speak("Hello")
