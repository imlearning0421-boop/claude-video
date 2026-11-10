"""Storyboard generation for the explainer-video app.

Turns a topic, a block of text, or a web link into a *story* storyboard for a
vertical (9:16) illustrated reel: a small cast of cartoon characters, everyday
scenes, phone screens (chats, calls, app cards, a shop page), one caption per
scene, and a closing lesson card. The browser renderer (static/app.js) draws it.

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

VISUALS = ("character", "two_characters", "phone", "photo", "lesson")
SETTINGS = ("home", "office", "night", "festive")
POSES = ("neutral", "phone_call", "holding_phone", "thinking", "sad", "happy", "surprised")
SCREENS = ("chat", "call", "card", "store")
GENDERS = ("male", "female")
SKINS = ("light", "medium", "tan", "dark")
HAIRS = ("short", "side_part", "curly", "long", "bun")
OUTFITS = ("shirt", "kurta", "tshirt", "kurti", "saree")
COLORS = ("blue", "green", "maroon", "mustard", "teal", "purple", "grey", "pink")
LANGUAGES = {
    "english": "English",
    "hindi": "Hindi (Devanagari script)",
    "hinglish": "Hinglish (Hindi written in Latin script, mixed naturally with English words)",
}
MAX_SOURCE_CHARS = 60_000
MAX_CAST = 3
URL_RE = re.compile(r"^https?://\S+$", re.IGNORECASE)


def _obj(props: dict) -> dict:
    """A strict JSON-schema object: every property required, nothing extra."""
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


_STR = {"type": "string"}
CAST_SCHEMA = _obj({
    "id": _STR,
    "name": _STR,
    "gender": {"type": "string", "enum": list(GENDERS)},
    "skin": {"type": "string", "enum": list(SKINS)},
    "hair": {"type": "string", "enum": list(HAIRS)},
    "beard": {"type": "boolean"},
    "outfit": {"type": "string", "enum": list(OUTFITS)},
    "color": {"type": "string", "enum": list(COLORS)},
})
PHONE_SCHEMA = _obj({
    "screen": {"type": "string", "enum": list(SCREENS)},
    "app": _STR,
    "messages": {"type": "array", "items": _obj({
        "side": {"type": "string", "enum": ["me", "them"]},
        "sender": _STR,
        "text": _STR,
    })},
    "title": _STR,
    "status": _STR,
    "lines": {"type": "array", "items": _STR},
    "button": _STR,
    "emoji": _STR,
})
SCENE_SCHEMA = _obj({
    "visual": {"type": "string", "enum": list(VISUALS)},
    "setting": {"type": "string", "enum": list(SETTINGS)},
    "character": _STR,
    "other_character": _STR,
    "other_setting": {"type": "string", "enum": list(SETTINGS)},
    "pose": {"type": "string", "enum": list(POSES)},
    "speaker": _STR,
    "narration": _STR,
    "highlight": {"type": "array", "items": _STR},
    "phone": PHONE_SCHEMA,
    "lesson": _obj({"book": _STR, "heading": _STR}),
})
STORYBOARD_SCHEMA = _obj({
    "title": _STR,
    "cast": {"type": "array", "items": CAST_SCHEMA},
    "scenes": {"type": "array", "items": SCENE_SCHEMA},
})

SYSTEM_PROMPT = """You write short vertical story reels that explain an idea through a relatable \
everyday story, in the style of illustrated Instagram/YouTube Shorts storytelling: simple cartoon \
characters in rooms, phone screens showing chats, calls and apps, one caption at a time, and a \
closing lesson card that names the idea.

You receive a topic, some information, or the text of a web page. Invent a small, believable \
situation (friends, family, office, college) whose characters run into that idea, let the story \
build to a turn, then end with lesson card(s) that state the idea plainly. When the source is a \
book, concept or principle, name it on the lesson card (lesson.book) and explain it accurately. \
Never invent statistics or facts about real people.

The renderer draws only these visuals, so tell the whole story with them:
- character: one cast member, half-body, in a room (setting). pose is one of neutral, phone_call \
(phone at ear), holding_phone (looking at the phone), thinking, sad, happy, surprised.
- two_characters: split screen, `character` on top in `setting`, `other_character` below in \
`other_setting`. Use it for phone conversations between two people.
- phone: a phone screen fills the frame. phone.screen is:
    chat: a messaging app. phone.app = contact or group name; phone.messages in order \
(side "me" = the main character, "them" = others, sender = their name for group chats).
    call: an incoming call. phone.app = caller's name.
    card: an app card such as a booking, leave approval, payment or reminder. phone.app = app \
name, phone.title = card heading, phone.status = short status chip ("Confirmed", "Approved"), \
phone.lines = 1-3 short "Label: value" rows, phone.button = button text.
    store: a shopping page. phone.app = shop name, phone.title = product, phone.emoji = one emoji \
picturing it, phone.lines = [short product subtitle], phone.button = "Add to Cart" or similar.
- photo: a framed old photo of the first two cast members (memories, childhood).
- lesson: the closing card. lesson.book = book or concept name ("" if none), lesson.heading = the \
big title shown on the card (usually the book or idea name). Use 1-3 lesson scenes at the end; \
their narration explains the idea.

Rules:
- cast: 1-3 people. id is a short lowercase slug; pick looks that suit each person (beard only for \
men). Use Indian names and settings when writing Hindi or Hinglish.
- 10-18 scenes for about a minute (fewer for shorter videos). One scene = one caption.
- narration: the caption and voice-over for that scene, at most 14 words. Narrator lines tell the \
story ("Amit ne dost ko message kiya—"); dialogue goes in double quotes with speaker = that \
character's id. Otherwise speaker = "narrator".
- highlight: 0-2 single words or short phrases copied exactly from the narration to colour.
- Switch visuals often, as a fast reel does; don't repeat the same visual more than twice in a row.
- Fields a visual doesn't use are "" or []; character must be a cast id for character, \
two_characters and photo scenes. Keep every phone text short enough to fit a phone screen."""


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
        what = f"Make a story reel that explains this: {source['content']}"
    elif source["kind"] == "url":
        what = (
            f"Make a story reel that explains the main idea of this web page "
            f"({source['url']}).\n\n<page>\n{source['content']}\n</page>"
        )
    else:
        what = f"Make a story reel that explains this information.\n\n<information>\n{source['content']}\n</information>"
    return (
        f"{what}\n\nWrite every caption, phone text and card in {lang}. "
        f"Aim for about {target_seconds} seconds of narration (roughly {max(5, target_seconds // 4)} scenes)."
    )


# ------------------------------------------------------------------- normalisation


def _clip(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _pick(value, allowed, default):
    return value if value in allowed else default


def estimate_duration(narration: str) -> float:
    """Seconds a caption stays up when there is no voice-over to time it."""
    words = len(narration.split())
    return round(min(9.0, max(2.2, 0.9 + words * 0.42)), 2)


def _slug(text: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "", str(text or "").lower())[:12]
    return slug or fallback


def _cast(raw_cast) -> list[dict]:
    cast, seen = [], set()
    for i, person in enumerate(raw_cast if isinstance(raw_cast, list) else []):
        if not isinstance(person, dict) or len(cast) >= MAX_CAST:
            continue
        cid = _slug(person.get("id") or person.get("name"), f"p{i}")
        if cid in seen or cid == "narrator":
            cid = f"{cid}{i}"
        seen.add(cid)
        gender = _pick(person.get("gender"), GENDERS, "male")
        cast.append({
            "id": cid,
            "name": _clip(person.get("name") or cid.title(), 24),
            "gender": gender,
            "skin": _pick(person.get("skin"), SKINS, "medium"),
            "hair": _pick(person.get("hair"), HAIRS, "short" if gender == "male" else "long"),
            "beard": bool(person.get("beard")) and gender == "male",
            "outfit": _pick(person.get("outfit"), OUTFITS, "shirt" if gender == "male" else "kurti"),
            "color": _pick(person.get("color"), COLORS, "blue"),
        })
    if not cast:
        cast.append({"id": "aarav", "name": "Aarav", "gender": "male", "skin": "medium", "hair": "short",
                     "beard": False, "outfit": "shirt", "color": "blue"})
    return cast


def _phone(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    messages = []
    for msg in raw.get("messages") or []:
        if isinstance(msg, dict) and _clip(msg.get("text"), 90):
            messages.append({
                "side": "me" if msg.get("side") == "me" else "them",
                "sender": _clip(msg.get("sender"), 20),
                "text": _clip(msg.get("text"), 90),
            })
    return {
        "screen": _pick(raw.get("screen"), SCREENS, "card"),
        "app": _clip(raw.get("app"), 28),
        "messages": messages[:5],
        "title": _clip(raw.get("title"), 40),
        "status": _clip(raw.get("status"), 18),
        "lines": [_clip(x, 40) for x in (raw.get("lines") or []) if _clip(x, 40)][:3],
        "button": _clip(raw.get("button"), 20),
        "emoji": _clip(raw.get("emoji"), 8),
    }


def normalize(board: dict) -> dict:
    """Clamp a storyboard to what the renderer can draw. Raises on an empty board."""
    scenes_in = board.get("scenes") if isinstance(board, dict) else None
    if not isinstance(scenes_in, list) or not scenes_in:
        raise StoryboardError("Claude returned an empty storyboard. Try again or add more detail.")
    cast = _cast(board.get("cast"))
    ids = [c["id"] for c in cast]
    by_name = {c["name"].lower(): c["id"] for c in cast}

    def who(value, default):
        value = str(value or "").strip().lower()
        if value in ids:
            return value
        return by_name.get(value, default)

    scenes = []
    for raw in scenes_in[:24]:
        if not isinstance(raw, dict):
            continue
        narration = _clip(raw.get("narration"), 140)
        if not narration:
            continue
        visual = _pick(raw.get("visual"), VISUALS, "character")
        character = who(raw.get("character"), ids[0])
        other = who(raw.get("other_character"), "")
        if visual == "two_characters" and (not other or other == character):
            other = next((i for i in ids if i != character), "")
            if not other:
                visual = "character"
        if visual == "photo" and len(ids) < 2:
            visual = "character"
        phone = _phone(raw.get("phone"))
        if visual == "phone" and phone["screen"] == "chat" and not phone["messages"]:
            phone["screen"] = "card"
        lesson = raw.get("lesson") if isinstance(raw.get("lesson"), dict) else {}
        speaker = who(raw.get("speaker"), "narrator")
        highlight = [_clip(h, 30) for h in (raw.get("highlight") or []) if _clip(h, 30)]
        scenes.append({
            "visual": visual,
            "setting": _pick(raw.get("setting"), SETTINGS, "home"),
            "character": character,
            "other_character": other if visual == "two_characters" else "",
            "other_setting": _pick(raw.get("other_setting"), SETTINGS, "festive"),
            "pose": _pick(raw.get("pose"), POSES, "neutral"),
            "speaker": speaker,
            "narration": narration,
            "highlight": [h for h in highlight if h.lower() in narration.lower()][:2],
            "phone": phone,
            "lesson": {"book": _clip(lesson.get("book"), 60), "heading": _clip(lesson.get("heading"), 70)},
            "duration": estimate_duration(narration),
        })
    if not scenes:
        raise StoryboardError("Claude returned an empty storyboard. Try again or add more detail.")
    return {"title": _clip(board.get("title") or scenes[0]["narration"], 100), "cast": cast, "scenes": scenes}


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


def _short_sentences(text: str) -> list[str]:
    """Split text into caption-sized pieces (at most ~14 words)."""
    pieces = []
    for sentence in _SENTENCE_RE.split(text.replace("\n", " ")):
        words = sentence.split()
        while words:
            pieces.append(" ".join(words[:14]))
            words = words[14:]
    return [p for p in pieces if p]


def generate_offline(source: dict, language: str = "english", target_seconds: int = 60) -> dict:
    """A simple storyboard built without Claude, so the app works with no API key.

    It only reshapes the user's own words; it adds no facts and no invented story.
    """
    label = source["label"]
    if source["kind"] == "text":
        label = " ".join(re.split(r"[.!?।:]", label, maxsplit=1)[0].split()[:7])
    lines = _short_sentences(source["content"])
    if source["kind"] == "topic" or len(lines) < 2:
        lines = [
            f"Aarav kab se {label} ke baare mein soch raha tha.",
            "Usne apne dost ko message kiya—",
            f"\"Yaar, {label} samjha de na?\"",
            "Dost ne kaha, \"Aaj shaam call karta hoon.\"",
            "Aarav ne socha, pehle khud padh leta hoon.",
            f"{label}: chhote steps mein samjho, ek-ek karke.",
        ] if language != "english" else [
            f"Aarav had been wondering about {label} for days.",
            "So he texted his friend—",
            f"\"Can you explain {label} to me?\"",
            "His friend said, \"I'll call you this evening.\"",
            "Aarav decided to read up on it first.",
            f"{label}: understand it in small steps, one at a time.",
        ]
    cast = [
        {"id": "aarav", "name": "Aarav", "gender": "male", "skin": "medium", "hair": "short",
         "beard": False, "outfit": "shirt", "color": "blue"},
        {"id": "ravi", "name": "Ravi", "gender": "male", "skin": "tan", "hair": "side_part",
         "beard": True, "outfit": "kurta", "color": "green"},
    ]
    poses = ["neutral", "thinking", "holding_phone", "phone_call", "happy"]
    scenes = []
    body, closing = lines[:-1] or lines, lines[-1]
    for i, line in enumerate(body[:12]):
        base = {"setting": "home", "character": "aarav", "other_character": "", "other_setting": "festive",
                "pose": poses[i % len(poses)], "speaker": "narrator", "narration": line, "highlight": [],
                "phone": {}, "lesson": {}}
        if i % 3 == 1:
            base.update(visual="phone", phone={"screen": "chat", "app": "Ravi",
                                               "messages": [{"side": "me", "sender": "", "text": line}]})
        elif i % 3 == 2:
            base.update(visual="phone", phone={"screen": "card", "app": "Notes", "title": label,
                                               "status": "Note", "lines": [line[:40]], "button": "Open"})
        else:
            base.update(visual="character")
        scenes.append(base)
    scenes.append({"visual": "lesson", "setting": "home", "character": "aarav", "narration": closing,
                   "speaker": "narrator", "highlight": [], "lesson": {"book": "", "heading": label}})
    return normalize({"title": label, "cast": cast, "scenes": scenes})


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
    board["language"] = language
    return {"storyboard": board, "engine": engine, "source": {"kind": source["kind"], "label": source["label"]}}
