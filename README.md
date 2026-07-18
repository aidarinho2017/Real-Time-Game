# Living Worlds

**A real-time AI demo where you can enter a generated world, direct a live movie, or edit your own video.**

Living Worlds pairs Reactor world, movie, and video-editing models with a small browser experience built for demos, kiosks, and curious first-time visitors. Choose a featured world, shape a Helios movie, or edit a webcam, clip, or still image with X2.

## Screenshots

### Featured worlds landing

 ![Featured worlds landing](docs/screenshots/01-landing.png) 

### Play mode

![Play mode](docs/screenshots/02-play.png) 
![Play mode](docs/screenshots/03-play.png) 

### Watch mode

 ![Watch mode](docs/screenshots/04-watch.png) 
 ![Watch mode](docs/screenshots/05-watch.png) 


## What you can do

- **Enter a featured world in one click.** Each curated world starts Play with its matching prompt and reference image.
- **Play a living world.** Move with the keyboard, reshape the scene, upload a reference image, or hold to talk in English.
- **Direct a real-time movie.** Set a prompt and optional visual anchor, then watch Helios generate live.
- **Edit your own video.** Use X2 with a webcam, uploaded clip, or still image; change its prompt live, add a reference image, drag to steer, and choose smoothness versus latency.
- **Keep or share the moment.** Save a prompt, settings, and public output frame to the gallery; download a JPEG snapshot; or share the current mode and prompt.

## Run locally

### Prerequisites

- Python 3.11+
- Node.js 20+
- Docker Compose (for local PostgreSQL and MinIO gallery storage)
- A Reactor API key with access to `lingbot-world-2`, `helios`, and `x2`
- A Deepgram API key for English speech-to-text

### Setup

```bash
cp backend/.env.example backend/.env
# Add REACTOR_API_KEY and DEEPGRAM_API_KEY to backend/.env

./start.sh
```

The launcher creates the backend virtual environment, starts the local gallery storage, and starts:

- PostgreSQL and MinIO through Docker Compose
- FastAPI at <http://127.0.0.1:8000>
- Vite at <http://127.0.0.1:5173>

The frontend proxies `/api` to FastAPI. API keys stay on the server; the browser receives only a short-lived Reactor token.

## Demo controls

### Play

- Use **WASD** to move and the **arrow keys** to look around.
- Edit the scene prompt and apply it, or select a visual preset.
- Hold **Hold to talk** for an action such as “find shelter.” Say `Change world to snowy ruins` to replace the scene instead.
- Capture a frame, share the prompt, or enter Theater mode from the bottom controls.

See [voice controls](docs/voice-controls.md) for voice behavior and troubleshooting.

### Watch

- Choose a movie direction and, optionally, a reference image for the opening shot.
- Watch includes a two-minute default session cap and an estimate based on Helios at `$6/hour`.
- Pause, restart, capture, share, or enter Theater mode while the movie runs.

### Edit

- Choose **Webcam**, **Video clip**, or **Still image** as the private source sent to X2.
- Set an edit instruction, optionally add a character/object reference image, and drag the output to steer the subject.
- Toggle **Keep every source frame** for smoother clip/image motion; leave it off for lowest webcam latency.
- Edit sessions stop after two minutes. Saving to the gallery stores an edited frame and settings, never the input video.

## Configuration

Copy `frontend/.env.example` to `frontend/.env` only when you need different local demo limits:

```bash
VITE_MAX_SESSION_SECONDS=600
VITE_MAX_WATCH_SECONDS=120
```

The backend also accepts `CORS_ORIGINS` in `backend/.env`; its default allows the local Vite addresses. Gallery storage defaults to the local PostgreSQL and MinIO services in `docker-compose.yml`; override `DATABASE_URL` and the `S3_*` values when deploying elsewhere.

## Architecture and privacy

The React frontend connects directly to the selected Reactor model after FastAPI exchanges the private Reactor API key for a short-lived browser token. Voice recordings are sent to Deepgram only for transcription and are not stored by this app. The public gallery permanently stores Play/Watch prompts and images, plus X2 edit prompts, settings, output frames, and optional reference images. It never stores webcam feeds, uploaded source videos, voice recordings, or resumable model sessions.

## Checks

Run these from `frontend/`:

```bash
npm run build
npm run test:voice
npm run test:share
```

Run backend checks from the repository root:

```bash
backend/.venv/bin/python -m unittest backend.test_voice_transcribe backend.test_gallery
```
