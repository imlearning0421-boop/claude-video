"""AI voice-over for the explainer app.

Turns one caption into speech (MP3 bytes) with ElevenLabs or OpenAI text-to-speech,
whichever key is set. ElevenLabs wins when both are present (its multilingual model
handles Hindi and Hinglish well).

    ELEVENLABS_API_KEY   use ElevenLabs (model eleven_multilingual_v2)
    OPENAI_API_KEY       use OpenAI (model gpt-4o-mini-tts)

Each caption has a role: the narrator, or a male / female character, and each role has
its own voice. Override the voices with EXPLAINER_VOICE_NARRATOR, EXPLAINER_VOICE_MALE
and EXPLAINER_VOICE_FEMALE (ElevenLabs voice IDs, or OpenAI voice names).
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict

ROLES = ("narrator", "male", "female")

# Default voices that free-plan API keys can use (free keys get a 402 for Voice Library
# voices such as Rachel). Swap any of them via the EXPLAINER_VOICE_* env vars.
ELEVENLABS_VOICES = {
    "narrator": "pNInz6obpgDQGcFmaJgB",  # Adam
    "male": "ErXwobaYiN019PkySvjV",      # Antoni
    "female": "EXAVITQu4vr4xnSDxMaL",    # Sarah
}
OPENAI_VOICES = {"narrator": "ash", "male": "onyx", "female": "coral"}
OPENAI_MODEL = "gpt-4o-mini-tts"
ELEVENLABS_MODEL = "eleven_multilingual_v2"
MAX_TEXT = 400

STYLE = {
    "narrator": "Warm, calm storyteller narrating a short reel. Natural pace, small pauses at dashes.",
    "male": "A young man speaking casually to a close friend, natural and expressive.",
    "female": "A young woman speaking casually to a close friend, natural and expressive.",
}
LANG_HINT = {
    "hinglish": "The text is Hinglish (Hindi in Latin letters mixed with English): pronounce it as natural Indian Hindi.",
    "hindi": "The text is Hindi: speak natural Indian Hindi.",
    "english": "Speak natural English with a light Indian accent.",
}


class VoiceError(Exception):
    """Speech could not be made; the message is safe to show the user."""


class _Busy(Exception):
    """HTTP 429: too many requests at once (free plans allow few) or no credit left; retried."""


def provider() -> str | None:
    if os.environ.get("ELEVENLABS_API_KEY"):
        return "elevenlabs"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return None


def voice_for(role: str, which: str) -> str:
    role = role if role in ROLES else "narrator"
    default = (ELEVENLABS_VOICES if which == "elevenlabs" else OPENAI_VOICES)[role]
    return os.environ.get(f"EXPLAINER_VOICE_{role.upper()}") or default


def _post(url: str, headers: dict, payload: dict, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={**headers, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read(400).decode("utf-8", "replace")
        if exc.code in (401, 403):
            raise VoiceError("The text-to-speech API key was rejected.") from exc
        if exc.code == 402:
            raise VoiceError("This voice needs a paid text-to-speech plan; pick another voice with "
                             "EXPLAINER_VOICE_NARRATOR / _MALE / _FEMALE.") from exc
        if exc.code == 429:
            raise _Busy(detail) from exc
        raise VoiceError(f"Text-to-speech failed ({exc.code}): {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise VoiceError(f"Could not reach the text-to-speech service: {exc}") from exc


def _elevenlabs(text: str, role: str, language: str) -> bytes:
    voice = voice_for(role, "elevenlabs")
    return _post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128",
        {"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Accept": "audio/mpeg"},
        {"text": text, "model_id": ELEVENLABS_MODEL,
         "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.3}},
    )


def _openai(text: str, role: str, language: str) -> bytes:
    return _post(
        "https://api.openai.com/v1/audio/speech",
        {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
        {"model": OPENAI_MODEL, "voice": voice_for(role, "openai"), "input": text,
         "instructions": f"{STYLE.get(role, STYLE['narrator'])} {LANG_HINT.get(language, LANG_HINT['english'])}",
         "response_format": "mp3"},
    )


_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_SIZE = 300


def speak(text: str, role: str = "narrator", language: str = "hinglish") -> bytes:
    """Return MP3 bytes for `text`. Repeated requests are served from memory, not re-billed."""
    text = " ".join(str(text or "").split())[:MAX_TEXT]
    if not text:
        raise VoiceError("Nothing to say.")
    which = provider()
    if which is None:
        raise VoiceError("No text-to-speech key is set (ELEVENLABS_API_KEY or OPENAI_API_KEY).")
    key = hashlib.sha256(f"{which}|{voice_for(role, which)}|{language}|{text}".encode()).hexdigest()
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    call = _elevenlabs if which == "elevenlabs" else _openai
    for attempt in range(4):
        try:
            audio = call(text, role, language)
            break
        except _Busy:
            if attempt == 3:
                raise VoiceError("The text-to-speech service is busy or out of credit. Try again in a minute.")
            time.sleep(1.5 * (attempt + 1))
    if len(audio) < 100:
        raise VoiceError("The text-to-speech service returned no audio.")
    with _CACHE_LOCK:
        _CACHE[key] = audio
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    return audio
