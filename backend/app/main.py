from __future__ import annotations

import os
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

REACTOR_TOKENS_URL = "https://api.reactor.inc/tokens"
DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


class TokenResponse(BaseModel):
    jwt: str


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

