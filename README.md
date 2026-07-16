# Living Worlds

Living Worlds lets you either play an interactive Lingbot World 2 session or watch a passive real-time Helios movie. The frontend connects to the selected Reactor model directly; FastAPI only exchanges the private Reactor API key for a short-lived browser token.

## Prerequisites

- Python 3.11+
- Node.js 20+
- A Reactor API key with access to `lingbot-world-2` and `helios`
- A Deepgram API key for English speech-to-text

## Run locally

Configure the backend once:

```bash
cp backend/.env.example backend/.env
# Put your Reactor and Deepgram keys in backend/.env
```

Then start both services with one command from any directory:

```bash
./start.sh
```

The launcher creates or reuses `backend/.venv`, installs missing Python dependencies there, installs frontend dependencies when needed, and starts:

- FastAPI: <http://127.0.0.1:8000>
- Vite: <http://127.0.0.1:5173>

The optional client-side demo budget can be configured in `frontend/.env`:

```bash
VITE_MAX_SESSION_SECONDS=600
VITE_MAX_WATCH_SECONDS=120
```

The launcher can also be invoked with an absolute path, for example `/home/aidarinho/Real Time Game/start.sh`, while your current directory is `backend/`.

The development server proxies `/api` to FastAPI. The browser never receives either API key.

## Play or Watch

The launch screen has two choices:

- **Play** opens the interactive Lingbot World 2 experience with keyboard and voice controls. Its default budget is 10 minutes.
- **Watch real-time movie** opens a movie-only prompt and optional reference-image setup, then starts a passive Helios stream. It has Pause, Restart, and Back controls, with a default two-minute budget.

Helios is billed separately by Reactor, so keep the Watch limit short unless you intentionally raise `VITE_MAX_WATCH_SECONDS`.

## Voice control

Hold **Hold to talk** while speaking, then release it to send an English command. The browser asks for microphone permission on first use; recordings are sent to Deepgram for transcription and are not saved by this app.

- `Change world to snowy ruins at night` replaces the scene direction.
- Any other phrase, such as `play football` or `Action play football`, sends a one-shot player action.

See [voice controls](docs/voice-controls.md) for the full behavior and troubleshooting notes. `DEEPGRAM_API_KEY` stays on the FastAPI server and is never sent to the browser.

## Notes

The bundled `frontend/src/assets/default-world.svg` is a replaceable local seed image. The planned generated raster asset could not be created in the current image-generation environment, so the prototype uses this lightweight fallback until a raster image is supplied.
