from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

REACTOR_TOKENS_URL = "https://api.reactor.inc/tokens"
DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen"
DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024


class TokenResponse(BaseModel):
    jwt: str


class VoiceTranscriptResponse(BaseModel):
    transcript: str


def configured_origins() -> list[str]:
    raw_origins = os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS)
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]


app = FastAPI(title="Living Worlds API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/reactor/token", response_model=TokenResponse)
async def issue_reactor_token() -> TokenResponse:
    api_key = os.getenv("REACTOR_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="REACTOR_API_KEY is not configured")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                REACTOR_TOKENS_URL,
                headers={"Reactor-API-Key": api_key},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Reactor") from exc

    if response.is_error:
        detail: Any = "Reactor rejected the token request"
        try:
            reactor_payload = response.json()
            if isinstance(reactor_payload, dict) and reactor_payload.get("detail"):
                detail = reactor_payload["detail"]
        except ValueError:
            pass
        raise HTTPException(status_code=502, detail=detail)

    try:
        payload = response.json()
        jwt = payload["jwt"]
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Reactor returned an invalid token response") from exc

    if not isinstance(jwt, str) or not jwt:
        raise HTTPException(status_code=502, detail="Reactor returned an empty token")

    return TokenResponse(jwt=jwt)


@app.post("/api/voice/transcribe", response_model=VoiceTranscriptResponse)
async def transcribe_voice(request: Request) -> VoiceTranscriptResponse:
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="DEEPGRAM_API_KEY is not configured")

    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("audio/"):
        raise HTTPException(status_code=415, detail="Send an audio recording.")

    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Voice recordings must be 10 MB or smaller.")

    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=422, detail="The voice recording was empty.")
    if len(audio) > MAX_VOICE_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Voice recordings must be 10 MB or smaller.")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                DEEPGRAM_LISTEN_URL,
                params={"model": "nova-3", "language": "en", "smart_format": "true"},
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": content_type,
                },
                content=audio,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Deepgram.") from exc

    if response.is_error:
        raise HTTPException(status_code=502, detail="Deepgram could not transcribe the recording.")

    try:
        payload = response.json()
        transcript = payload["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Deepgram returned an invalid transcription response.") from exc

    if not isinstance(transcript, str) or not transcript.strip():
        raise HTTPException(status_code=422, detail="No speech was recognized. Try again.")

    return VoiceTranscriptResponse(transcript=transcript.strip())
