from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel


class TokenResponse(BaseModel):
    jwt: str


class VoiceTranscriptResponse(BaseModel):
    transcript: str


class WorldResponse(BaseModel):
    id: UUID
    mode: Literal["play", "watch", "edit"]
    prompt: str
    seed: int
    image_url: str
    source_type: Literal["webcam", "video", "image"] | None = None
    keep_backlog: bool | None = None
    reference_image_url: str | None = None
    created_at: datetime


class WorldPage(BaseModel):
    items: list[WorldResponse]
    next_cursor: str | None = None


class StudioWorldCreate(BaseModel):
    name: str
    description: str = ""
    initial_prompt: str


class StudioWorldStateUpdate(BaseModel):
    state: dict[str, Any]


class StudioWorldCommand(BaseModel):
    command: str


class StudioWorldQuery(BaseModel):
    question: str


class StudioWorldRenderRequest(BaseModel):
    shot: Literal["current", "event", "character", "cinematic", "drone", "close-up"] = "cinematic"
    event_revision: int | None = None
    character: str | None = None


class StudioWorldEventResponse(BaseModel):
    revision: int
    command: str
    summary: str
    created_at: datetime


class StudioWorldResponse(BaseModel):
    id: UUID
    name: str
    description: str
    initial_prompt: str
    state: dict[str, Any]
    current_revision: int
    created_at: datetime
    updated_at: datetime
    events: list[StudioWorldEventResponse] = []


class StudioWorldListItem(BaseModel):
    id: UUID
    name: str
    description: str
    current_revision: int
    updated_at: datetime


class StudioWorldQueryResponse(BaseModel):
    answer: str


class StudioWorldRenderResponse(BaseModel):
    prompt: str
    state: dict[str, Any]
