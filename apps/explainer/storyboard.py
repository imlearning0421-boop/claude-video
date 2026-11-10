"""Storyboard generation for the explainer-video app.

Turns a topic, a block of text, or a web link into a storyboard: a list of
motion-graphics scenes the browser renderer (static/app.js) animates.

Claude writes the storyboard when an Anthropic credential is available; an
offline generator keeps the app usable (and testable) without one.
"""
from __future__ import annotations

import html
import json
import re
import urllib.request
from html.parser import HTMLParser

MODEL = "claude-opus-5-5"

SCENE_TYPES = ("title", "bullets", "stat", "steps", "comparison", "quote", "outro")
PALETTES = ("sunset", "ocean", "forest", "neon", "candy", "mono")
LANGUAGES = {
    "english": "English",
    "hindi": "Hindi (Devanagari script)",
    "hinglish": "Hinglish (Hindi written in Latin script, mixed with English words)",
}
MAX_SOURCE_CHARS = 60_000
URL_RE = re.compile(r"^https?://\S+$", re.IGNORECASE)

# Structured-output schema. Every field is required so the renderer never has to
# guess; scene types that don't use a field get "" or [].
SCENE_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(SCENE_TYPES)},
        "heading": {"type": "string"},
        "subheading": {"type": "string"},
        "emoji": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "emoji": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["emoji", "text"],
                "additionalProperties": False,
            },
        },
        "value": {"type": "string"},
        "narration": {"type": "string"},
        "duration": {"type": "number"},
    },
    "required": ["type", "heading", "subheading", "emoji", "items", "value", "narration", "duration"],
    "additionalProperties": False,
}

STORYBOARD_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "palette": {"type": "string", "enum": list(PALETTES)},
        "scenes": {"type": "array", "items": SCENE_SCHEMA},
    },
    "required": ["title", "palette", "scenes"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You are the writer and art director of short motion-graphics explainer videos \
(the animated, kinetic-typography style used by good YouTube explainers).

You receive a topic, some information, or the text of a web page. Turn it into a storyboard that \
a renderer animates scene by scene. The renderer draws only text, emoji and shapes, so put every \
idea into the fields below; never describe visuals that need footage or photos.

Scene types and the fields each one uses:
- title: heading (the hook, at most 6 words), subheading (one short line), emoji. Always the first scene.
- bullets: heading, items (2-4 items, each an emoji and at most 7 words of text).
- stat: value (a striking number with its unit, such as "70%", "8 min", "1.5 billion"), heading \
(what the number means, at most 8 words), emoji. Use only numbers the source supports or that are \
well established; never invent statistics.
- steps: heading, items (3-4 steps of at most 5 words each, in order).
- comparison: heading, exactly 2 items (the two sides, each an emoji and at most 4 words), \
subheading (the key difference, one line).
- quote: heading (a definition, key insight or memorable line, at most 18 words), subheading \
(who said it or "Key idea"), emoji.
- outro: heading (the one-line takeaway), subheading (a closing nudge), emoji. Always the last scene.

Rules:
- 6 to 9 scenes, mixing types so the video stays visually varied. Do not repeat a type back to back.
- narration: what a voice-over says during the scene, 1-2 conversational sentences. It is shown as \
subtitles, so keep it under 30 words.
- duration: seconds the scene stays on screen, between 4 and 9, long enough to read the narration.
- Fields a scene type doesn't use are "" (or [] for items).
- Pick the palette that suits the topic's mood.
- On-screen text is short and punchy; the narration carries the detail.
- Be accurate. If the source is thin, explain only what you are confident is true."""


class StoryboardError(Exception):
    """A storyboard could not be produced; the message is safe to show the user."""


# --------------------------------------------------------------------------- input


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe"}
    BLOCK = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "section", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(markup: str) -> tuple[str, str]:
    """Return (title, readable text) for an HTML page."""
    parser = _TextExtractor()
    parser.feed(markup)
    parser.close()
    text = "".join(parser.parts)
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.split("\n")]
    text = "\n".join(line for line in lines if line)
    return html.unescape(parser.title).strip(), text


def fetch_url(url: str, timeout: float = 20.0) -> tuple[str, str]:
    """Download a web page and return (title, text)."""
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (explainer-video-app)", "Accept": "text/html,*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(3_000_000)
            charset = response.headers.get_content_charset() or "utf-8"
            ctype = response.headers.get_content_type()
    except Exception as exc:  # noqa: BLE001 - surface any network failure to the user
        raise StoryboardError(f"Could not open the link: {exc}") from exc
    body = raw.decode(charset, errors="replace")
    if ctype == "text/plain":
        return "", body.strip()
    title, text = html_to_text(body)
    if len(text) < 80:
        raise StoryboardError("The link opened, but there was almost no readable text on the page.")
    return title, text


def classify_input(raw: str) -> str:
    """'url', 'topic' (a short phrase) or 'text' (pasted information)."""
    raw = raw.strip()
    if URL_RE.match(raw):
        return "url"
    if len(raw) <= 120 and "\n" not in raw:
        return "topic"
    return "text"


def build_source(raw: str) -> dict:
    """Resolve the user's input into {'kind', 'label', 'content'}."""
    raw = (raw or "").strip()
    if not raw:
        raise StoryboardError("Type a topic, paste some information, or paste a link first.")
    kind = classify_input(raw)
    if kind == "url":
        title, text = fetch_url(raw)
        return {"kind": "url", "label": title or raw, "content": text[:MAX_SOURCE_CHARS], "url": raw}
    return {"kind": kind, "label": raw.split("\n", 1)[0][:80], "content": raw[:MAX_SOURCE_CHARS]}


def user_prompt(source: dict, language: str, target_seconds: int) -> str:
    lang = LANGUAGES.get(language, LANGUAGES["english"])
    if source["kind"] == "topic":
        what = f"Make an explainer video about this topic: {source['content']}"
    elif source["kind"] == "url":
        what = (
            f"Make an explainer video that explains the main ideas of this web page "
            f"({source['url']}).\n\n<page>\n{source['content']}\n</page>"
        )
    else:
        what = f"Make an explainer video from this information.\n\n<information>\n{source['content']}\n</information>"
    return (
        f"{what}\n\nWrite all on-screen text and narration in {lang}. "
        f"Aim for a total length of about {target_seconds} seconds."
    )


# ------------------------------------------------------------------- normalisation


def _clip(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def normalize(board: dict) -> dict:
    """Clamp a storyboard to what the renderer can draw. Raises on an empty board."""
    scenes_in = board.get("scenes") if isinstance(board, dict) else None
    if not isinstance(scenes_in, list) or not scenes_in:
        raise StoryboardError("Claude returned an empty storyboard. Try again or add more detail.")
    scenes = []
    for scene in scenes_in[:12]:
        if not isinstance(scene, dict):
            continue
        kind = scene.get("type") if scene.get("type") in SCENE_TYPES else "bullets"
        items = []
        for item in scene.get("items") or []:
            if isinstance(item, dict) and _clip(item.get("text"), 60):
                items.append({"emoji": _clip(item.get("emoji"), 8), "text": _clip(item.get("text"), 60)})
        limit = {"comparison": 2, "steps": 4, "bullets": 4}.get(kind, 4)
        items = items[:limit]
        if kind in ("bullets", "steps") and not items:
            kind = "quote"
        if kind == "comparison" and len(items) < 2:
            kind = "bullets" if items else "quote"
        if kind == "stat" and not _clip(scene.get("value"), 20):
            kind = "quote"
        try:
            duration = float(scene.get("duration") or 6)
        except (TypeError, ValueError):
            duration = 6.0
        scenes.append({
            "type": kind,
            "heading": _clip(scene.get("heading"), 140),
            "subheading": _clip(scene.get("subheading"), 120),
            "emoji": _clip(scene.get("emoji"), 8),
            "items": items,
            "value": _clip(scene.get("value"), 20),
            "narration": _clip(scene.get("narration"), 260),
            "duration": round(min(10.0, max(3.5, duration)), 2),
        })
    if not scenes:
        raise StoryboardError("Claude returned an empty storyboard. Try again or add more detail.")
    palette = board.get("palette") if board.get("palette") in PALETTES else "sunset"
    return {"title": _clip(board.get("title") or scenes[0]["heading"], 100), "palette": palette, "scenes": scenes}


# ------------------------------------------------------------------- generators


def generate_with_claude(source: dict, language: str, target_seconds: int, client=None) -> dict:
    """Ask Claude for a storyboard. Raises StoryboardError with a readable message."""
    import anthropic  # imported lazily so the offline mode needs no extra packages

    client = client or anthropic.Anthropic()
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=32000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive"},
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": STORYBOARD_SCHEMA},
            },
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt(source, language, target_seconds)}],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError as exc:
        raise StoryboardError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.") from exc
    except anthropic.RateLimitError as exc:
        raise StoryboardError("Claude is rate-limited right now. Wait a minute and try again.") from exc
    except anthropic.BadRequestError as exc:
        raise StoryboardError(f"Claude rejected the request: {exc.message}") from exc
    except anthropic.APIStatusError as exc:
        raise StoryboardError(f"Claude API error ({exc.status_code}). Try again shortly.") from exc
    except anthropic.APIConnectionError as exc:
        raise StoryboardError("Could not reach the Claude API. Check your internet connection.") from exc

    if message.stop_reason == "refusal":
        raise StoryboardError("Claude declined to make a video about this input.")
    if message.stop_reason == "max_tokens":
        raise StoryboardError("The storyboard came back cut off. Try a shorter input.")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        board = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StoryboardError("Claude's storyboard was not valid JSON. Try again.") from exc
    return normalize(board)


_SENTENCE_RE = re.compile(r"(?<=[.!?।])\s+")
_EMOJIS = ["💡", "🚀", "🔍", "⚙️", "🌍", "📈", "🧠", "✨", "🎯", "🔗", "📌", "🧩"]


def generate_offline(source: dict, language: str = "english", target_seconds: int = 60) -> dict:
    """A simple storyboard built without Claude, so the app works with no API key.

    It only reshapes the user's own words; it adds no facts.
    """
    label = source["label"]
    if source["kind"] == "text":
        label = " ".join(re.split(r"[.!?।:]", label, maxsplit=1)[0].split()[:7])
    sentences = [s.strip() for s in _SENTENCE_RE.split(source["content"].replace("\n", " ")) if s.strip()]
    if source["kind"] == "topic" or len(sentences) < 2:
        topic = label
        sentences = [
            f"{topic}: what it is, why it matters, and how it works.",
            f"Start with the core idea behind {topic}.",
            f"Then look at the main parts that make {topic} work.",
            f"Finally, see where {topic} shows up in real life.",
        ]
    short = [_clip(s, 60) for s in sentences]
    numbers = re.findall(r"\b\d[\d,.]*\s?(?:%|percent|million|billion|crore|lakh|km|kg|years?)?", source["content"])
    scenes = [{
        "type": "title", "heading": _clip(label, 50), "subheading": "Explained in a minute",
        "emoji": "🎬", "items": [], "value": "", "narration": sentences[0], "duration": 5,
    }]
    scenes.append({
        "type": "bullets", "heading": "The big picture", "subheading": "", "emoji": "",
        "items": [{"emoji": _EMOJIS[i % len(_EMOJIS)], "text": _clip(s, 48)} for i, s in enumerate(short[1:4])],
        "value": "", "narration": " ".join(sentences[1:3]), "duration": 7,
    })
    if numbers:
        scenes.append({
            "type": "stat", "heading": _clip(next((s for s in sentences if numbers[0] in s), label), 60),
            "subheading": "", "emoji": "📊", "items": [], "value": numbers[0].strip(),
            "narration": _clip(next((s for s in sentences if numbers[0] in s), ""), 200), "duration": 6,
        })
    if len(short) > 4:
        scenes.append({
            "type": "steps", "heading": "Step by step", "subheading": "", "emoji": "",
            "items": [{"emoji": "", "text": _clip(s, 32)} for s in short[4:8]],
            "value": "", "narration": " ".join(sentences[4:6]), "duration": 8,
        })
    scenes.append({
        "type": "quote", "heading": _clip(max(sentences, key=len), 120), "subheading": "Key idea",
        "emoji": "💬", "items": [], "value": "", "narration": _clip(max(sentences, key=len), 200), "duration": 7,
    })
    scenes.append({
        "type": "outro", "heading": _clip(label, 60), "subheading": "Now you know!",
        "emoji": "✅", "items": [], "value": "", "narration": "That's the idea in a nutshell.", "duration": 5,
    })
    return normalize({"title": label, "palette": "sunset", "scenes": scenes})


def has_claude_credentials() -> bool:
    import os

    if os.environ.get("EXPLAINER_OFFLINE"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                or os.environ.get("ANTHROPIC_PROFILE") or _has_ant_profile())


def _has_ant_profile() -> bool:
    from pathlib import Path

    return (Path.home() / ".config" / "anthropic").is_dir()


def make_storyboard(raw: str, language: str = "english", target_seconds: int = 60,
                    use_claude: bool | None = None) -> dict:
    """Entry point used by the server. Returns {'storyboard', 'engine', 'source'}."""
    language = language if language in LANGUAGES else "english"
    target_seconds = int(min(180, max(20, int(target_seconds or 60))))
    source = build_source(raw)
    if use_claude is None:
        use_claude = has_claude_credentials()
    if use_claude:
        board, engine = generate_with_claude(source, language, target_seconds), "claude"
    else:
        board, engine = generate_offline(source, language, target_seconds), "offline"
    return {"storyboard": board, "engine": engine, "source": {"kind": source["kind"], "label": source["label"]}}
