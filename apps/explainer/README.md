# Explainer Studio

Type a **topic**, paste some **information**, or paste a **web link**. Claude writes a
storyboard, and the app animates it as a **motion-graphics explainer video** (kinetic text,
animated icons, counters, flow diagrams, transitions, subtitles and background music) that
you can download as WebM or MP4.

## Run it

```bash
pip install -r apps/explainer/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # or sign in once with `ant auth login`
python3 apps/explainer/server.py         # open http://localhost:8765
```

With no API key the app still runs in **offline demo mode**: it rearranges your own text
into scenes, but doesn't research a topic or add anything new. Install `ffmpeg` to get the
**MP4** button (WebM downloads work without it).

## How to use it

1. Type something in the box:
   - a topic: `How do black holes form?`
   - information: paste notes, an article or a paragraph
   - a link: `https://en.wikipedia.org/wiki/Photosynthesis`
2. Choose the language (English, Hinglish or Hindi) and the length, then click **Create explainer video**.
3. The video plays in the preview. In the storyboard you can change any text, item, narration
   line, scene length, or the colour style; the preview updates straight away.
4. Click **Render video**. The video plays through once while it records (keep the tab
   visible), and then **WebM** and **MP4** download buttons appear.

The **voice-over** checkbox reads the narration aloud in the preview using your browser's
voice. That voice can't be recorded, so downloaded videos carry the narration as subtitles.

## How it works

| Piece | What it does |
|-------|--------------|
| `storyboard.py` | Works out whether the input is a topic, text or URL. For a URL it downloads the page and extracts the readable text. It then asks Claude (`claude-opus-5-5`, structured JSON output) for 6–9 scenes and cleans up the result. |
| `server.py` | Standard-library HTTP server: serves the page, `POST /api/storyboard`, and `POST /api/mp4` (converts WebM to MP4 with ffmpeg). |
| `static/app.js` | Canvas renderer. Every frame is a pure function of time, so preview, seeking and recording use the same code. Scene types: `title`, `bullets`, `stat`, `steps`, `comparison`, `quote`, `outro`. Music is generated with WebAudio and recorded alongside the canvas through `MediaRecorder`. |

Tests: `python3 -m pytest -q tests/test_explainer.py`
