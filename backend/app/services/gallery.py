from __future__ import annotations

import base64
import binascii
import io
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID, uuid4

import psycopg
from botocore.exceptions import BotoCoreError, ClientError
from PIL import Image, UnidentifiedImageError

from ..core.database import initialize_database
from ..core.storage import delete_image, initialize_bucket, put_image, read_image
from ..domain.worlds import World, WorldMode
from ..repositories import worlds

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
IMAGE_TYPES = {"JPEG": ("image/jpeg", "jpg"), "PNG": ("image/png", "png"), "WEBP": ("image/webp", "webp"), "GIF": ("image/gif", "gif")}


class GalleryError(RuntimeError):
    pass


class GalleryValidationError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class InvalidCursorError(ValueError):
    pass


@dataclass(frozen=True)
class ValidatedImage:
    content_type: str
    extension: str


def initialize_gallery() -> None:
    try:
        initialize_database()
        initialize_bucket()
    except (BotoCoreError, ClientError, psycopg.Error) as exc:
        raise GalleryError("Local gallery storage is unavailable. Start Docker Compose and try again.") from exc


def validate_image(data: bytes) -> ValidatedImage:
    if not data:
        raise GalleryValidationError(422, "Choose an image to save.")
    if len(data) > MAX_IMAGE_BYTES:
        raise GalleryValidationError(413, "Images must be 10 MB or smaller.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image_format = image.format
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise GalleryValidationError(413, "Images must be 40 megapixels or smaller.")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise GalleryValidationError(422, "Choose a valid PNG, JPEG, WebP, or GIF image.") from exc

    if image_format not in IMAGE_TYPES:
        raise GalleryValidationError(415, "Use a PNG, JPEG, WebP, or GIF image.")
    return ValidatedImage(*IMAGE_TYPES[image_format])


def image_key(world_id: UUID, extension: str) -> str:
    return f"worlds/{world_id}.{extension}"


def save_world(
    mode: WorldMode,
    prompt: str,
    seed: int,
    image_data: bytes,
    image_filename: str,
    image: ValidatedImage,
) -> World:
    world_id = uuid4()
    key = image_key(world_id, image.extension)
    try:
        put_image(key, image_data, image.content_type)
        return worlds.create_world(world_id, mode, prompt, seed, key, image_filename, image.content_type)
    except (BotoCoreError, ClientError, psycopg.Error, RuntimeError) as exc:
        try:
            delete_image(key)
        except (BotoCoreError, ClientError):
            pass
        raise GalleryError("Could not save this world.") from exc


def get_world(world_id: UUID) -> World | None:
    try:
        return worlds.get_world(world_id)
    except psycopg.Error as exc:
        raise GalleryError("Could not load the gallery.") from exc


def encode_cursor(created_at: datetime, world_id: UUID) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{world_id}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        encoded = cursor + "=" * (-len(cursor) % 4)
        created_at_raw, world_id_raw = base64.urlsafe_b64decode(encoded).decode().split("|", 1)
        created_at = datetime.fromisoformat(created_at_raw)
        if created_at.tzinfo is None:
            raise ValueError
        return created_at, UUID(world_id_raw)
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise InvalidCursorError("The gallery cursor is invalid.") from exc


def list_worlds(mode: WorldMode | None, limit: int, cursor: str | None) -> tuple[list[World], str | None]:
    try:
        rows = worlds.list_worlds(mode, decode_cursor(cursor) if cursor else None, limit + 1)
    except psycopg.Error as exc:
        raise GalleryError("Could not load the gallery.") from exc
    next_cursor = encode_cursor(rows[limit - 1].created_at, rows[limit - 1].id) if len(rows) > limit else None
    return rows[:limit], next_cursor


def get_world_image(world_id: UUID) -> tuple[World, bytes] | None:
    world = get_world(world_id)
    if world is None:
        return None
    try:
        return world, read_image(world.image_key)
    except (BotoCoreError, ClientError) as exc:
        raise GalleryError("Could not load this world image.") from exc
