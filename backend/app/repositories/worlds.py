from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from ..core.database import connect
from ..domain.worlds import World, WorldMode

WORLD_COLUMNS = "id, mode, prompt, seed, image_key, image_filename, image_content_type, created_at"


def world_from_row(row: dict[str, Any]) -> World:
    return World(**row)


def create_world(
    world_id: UUID,
    mode: WorldMode,
    prompt: str,
    seed: int,
    image_key: str,
    image_filename: str,
    image_content_type: str,
) -> World:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                f"""INSERT INTO worlds ({WORLD_COLUMNS.removesuffix(', created_at')})
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING {WORLD_COLUMNS}""",
                (world_id, mode, prompt, seed, image_key, image_filename, image_content_type),
            )
            row = cursor.fetchone()
    if row is None:
        raise RuntimeError("The database did not return the saved world.")
    return world_from_row(row)


def get_world(world_id: UUID) -> World | None:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {WORLD_COLUMNS} FROM worlds WHERE id = %s", (world_id,))
            row = cursor.fetchone()
    return world_from_row(row) if row else None


def list_worlds(mode: WorldMode | None, before: tuple[datetime, UUID] | None, limit: int) -> list[World]:
    conditions: list[str] = []
    values: list[Any] = []
    if mode:
        conditions.append("mode = %s")
        values.append(mode)
    if before:
        conditions.append("(created_at, id) < (%s, %s)")
        values.extend(before)
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    values.append(limit)
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {WORLD_COLUMNS} FROM worlds{where} ORDER BY created_at DESC, id DESC LIMIT %s", values)
            return [world_from_row(row) for row in cursor.fetchall()]
