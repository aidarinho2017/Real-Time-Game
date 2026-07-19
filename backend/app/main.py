from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routers import reactor, studio_worlds, voice, worlds
from .core.config import get_settings
from .services.gallery import initialize_gallery


@asynccontextmanager
async def lifespan(_: FastAPI):
    await asyncio.to_thread(initialize_gallery)
    yield


app = FastAPI(title="Living Worlds API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.include_router(reactor.router)
app.include_router(voice.router)
app.include_router(worlds.router)
app.include_router(studio_worlds.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
