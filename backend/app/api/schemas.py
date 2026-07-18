from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class TokenResponse(BaseModel):
    jwt: str


class VoiceTranscriptResponse(BaseModel):
    transcript: str


class WorldResponse(BaseModel):
    id: UUID
    mode: Literal["play", "watch"]
    prompt: str
    seed: int
    image_url: str
    created_at: datetime


class WorldPage(BaseModel):
    items: list[WorldResponse]
    next_cursor: str | None = None
