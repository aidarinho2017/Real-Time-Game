# Living Worlds

Living Worlds is a browser exploration prototype powered by Reactor's Lingbot World 2 model. The frontend connects to the model directly for low-latency video and input; FastAPI only exchanges the private Reactor API key for a short-lived browser token.

## Prerequisites

- Python 3.11+
- Node.js 20+
- A Reactor API key with access to `lingbot-world-2`

## Run locally

Configure the backend once:

```bash
cp backend/.env.example backend/.env
# Put your Reactor key in backend/.env
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
```

The launcher can also be invoked with an absolute path, for example `/home/aidarinho/Real Time Game/start.sh`, while your current directory is `backend/`.

The development server proxies `/api` to FastAPI. The browser never receives `REACTOR_API_KEY`.

## Notes

The bundled `frontend/src/assets/default-world.svg` is a replaceable local seed image. The planned generated raster asset could not be created in the current image-generation environment, so the prototype uses this lightweight fallback until a raster image is supplied.
