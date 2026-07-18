from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

WorldMode = Literal["play", "watch"]


@dataclass(frozen=True)
class World:
    id: UUID
    mode: WorldMode
    prompt: str
    seed: int
    image_key: str
    image_filename: str
    image_content_type: str
    created_at: datetime
