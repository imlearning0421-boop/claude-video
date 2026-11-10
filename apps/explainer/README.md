# Explainer Studio

Type a **topic**, paste some **information**, or paste a **web link**. Claude turns it into a
short **vertical story reel** (9:16, for Reels and Shorts). The app animates it and records it as
a video you can download as WebM or MP4.

The reel tells a small everyday story that leads to the idea:

- flat cartoon characters in rooms (home, office, night, festive)
- phone screens: a chat, an incoming call, an app card (booking, approval, payment) and a shop page
- split-screen phone calls and a framed old photo
- captions with highlighted keywords
- a closing lesson card that names the idea
- an **AI voice-over**, with separate voices for the narrator, male characters and female characters

## Run it

```bash
pip install -r apps/explainer/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # story writing (or sign in once with `ant auth login`)
export ELEVENLABS_API_KEY=...            # AI voice-over; or OPENAI_API_KEY=...
python3 apps/explainer/server.py         # open http://localhost:8765
```

| Key | What it does without the key |
|-----|------------------------------|
| `ANTHROPIC_API_KEY` | Without it the app runs in **offline demo mode**. It cuts your own text into scenes, but doesn't write a story or add facts. |
| `ELEVENLABS_API_KEY` or `OPENAI_API_KEY` | Without one there is no AI voice: the video has captions and music only. If both are set, ElevenLabs (`eleven_multilingual_v2`) is used over OpenAI (`gpt-4o-mini-tts`). |
| `EXPLAINER_VOICE_NARRATOR` / `_MALE` / `_FEMALE` | Optional: pick other voices (ElevenLabs voice IDs, or OpenAI voice names). |

Install `ffmpeg` to get the **MP4** button. WebM downloads work without it.

## How to use it

1. Type a topic, paste information, or paste a link. Pick the language (Hinglish, English or
   Hindi) and the length, then click **Story video banao**.
2. Claude writes the story. If a voice key is set, a voice clip is made for each caption, and
   each scene lasts as long as its clip. The preview then plays.
3. In the storyboard you can change any caption, the highlighted words, the phone texts
   (one chat message per line as `me: …` or `Name: …`), or a lesson card title. After you edit
   captions, click **🎙 Voice dobara banao** to remake those voice clips.
4. Click **Video render karo**. The reel plays once while it records, so keep the tab visible.
   Then the **WebM** and **MP4** buttons appear. The voice-over and music are included in the file.

Voice clips are cached in memory on the server, so playing or rendering again doesn't pay for
the same line twice.

## How it works

| Piece | What it does |
|-------|--------------|
| `storyboard.py` | Works out whether the input is a topic, text or URL, and extracts the text from a web page. It asks Claude (`claude-opus-5-5`, structured JSON output) for a cast and 10–18 scenes, then cleans the result so every scene can be drawn. |
| `tts.py` | Voice-over through ElevenLabs or OpenAI text-to-speech, with one voice per role and an in-memory cache. |
| `server.py` | Standard-library HTTP server: the page, `POST /api/storyboard`, `POST /api/voice`, and `POST /api/mp4` (converts WebM to MP4 with ffmpeg). |
| `static/app.js` | Canvas renderer (720×1280). Every frame is a pure function of time, so preview, seeking and recording share the same code. Voice clips are scheduled in WebAudio against the scene start times and recorded with the canvas through `MediaRecorder`. |

Tests: `python3 -m pytest -q tests/test_explainer.py`
