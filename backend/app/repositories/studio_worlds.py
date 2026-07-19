from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from ..core.database import connect

STUDIO_WORLD_COLUMNS = "id, name, description, initial_prompt, initial_state, state, current_revision, last_render_key, last_render_content_type, last_rendered_at, created_at, updated_at"
EVENT_COLUMNS = "revision, command, summary, before_state, after_state, created_at"


class StudioWorldMissingError(LookupError):
    pass


class StudioWorldConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class StudioWorld:
    id: UUID
    name: str
    description: str
    initial_prompt: str
    initial_state: dict[str, Any]
    state: dict[str, Any]
    current_revision: int
    last_render_key: str | None
    last_render_content_type: str | None
    last_rendered_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class StudioWorldEvent:
    revision: int
    command: str
    summary: str
    created_at: datetime
    before_state: dict[str, Any] = field(default_factory=dict)
    after_state: dict[str, Any] = field(default_factory=dict)


def world_from_row(row: dict[str, Any]) -> StudioWorld:
    return StudioWorld(**row)


def event_from_row(row: dict[str, Any]) -> StudioWorldEvent:
    return StudioWorldEvent(**row)


def create_world(name: str, description: str, initial_prompt: str, state: dict[str, Any]) -> StudioWorld:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                f"""INSERT INTO studio_worlds (id, name, description, initial_prompt, initial_state, state)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING {STUDIO_WORLD_COLUMNS}""",
                (uuid4(), name, description, initial_prompt, Jsonb(state), Jsonb(state)),
            )
            row = cursor.fetchone()
    if row is None:
        raise RuntimeError("The database did not return the created world.")
    return world_from_row(row)


def get_world(world_id: UUID) -> StudioWorld | None:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {STUDIO_WORLD_COLUMNS} FROM studio_worlds WHERE id = %s", (world_id,))
            row = cursor.fetchone()
    return world_from_row(row) if row else None


def list_worlds(limit: int) -> list[StudioWorld]:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {STUDIO_WORLD_COLUMNS} FROM studio_worlds ORDER BY updated_at DESC LIMIT %s", (limit,))
            return [world_from_row(row) for row in cursor.fetchall()]


def list_events(world_id: UUID) -> list[StudioWorldEvent]:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {EVENT_COLUMNS} FROM studio_world_events WHERE world_id = %s ORDER BY revision", (world_id,))
            return [event_from_row(row) for row in cursor.fetchall()]


def add_change(
    world_id: UUID,
    expected_revision: int,
    command: str,
    summary: str,
    before_state: dict[str, Any],
    after_state: dict[str, Any],
) -> StudioWorld:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT current_revision FROM studio_worlds WHERE id = %s FOR UPDATE", (world_id,))
            current = cursor.fetchone()
            if current is None:
                raise StudioWorldMissingError()
            if current["current_revision"] != expected_revision:
                raise StudioWorldConflictError("This world changed in another session. Reload it and try again.")
            cursor.execute("DELETE FROM studio_world_events WHERE world_id = %s AND revision > %s", (world_id, expected_revision))
            next_revision = expected_revision + 1
            cursor.execute(
                """INSERT INTO studio_world_events (id, world_id, revision, command, summary, before_state, after_state)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (uuid4(), world_id, next_revision, command, summary, Jsonb(before_state), Jsonb(after_state)),
            )
            cursor.execute(
                f"""UPDATE studio_worlds
                    SET state = %s, current_revision = %s, updated_at = NOW()
                    WHERE id = %s RETURNING {STUDIO_WORLD_COLUMNS}""",
                (Jsonb(after_state), next_revision, world_id),
            )
            row = cursor.fetchone()
    if row is None:
        raise StudioWorldMissingError()
    return world_from_row(row)


def set_last_render(world_id: UUID, image_key: str, content_type: str) -> StudioWorld:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                f"""UPDATE studio_worlds
                    SET last_render_key = %s, last_render_content_type = %s, last_rendered_at = NOW(), updated_at = NOW()
                    WHERE id = %s RETURNING {STUDIO_WORLD_COLUMNS}""",
                (image_key, content_type, world_id),
            )
            row = cursor.fetchone()
    if row is None:
        raise StudioWorldMissingError()
    return world_from_row(row)


def undo(world_id: UUID) -> StudioWorld:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {STUDIO_WORLD_COLUMNS} FROM studio_worlds WHERE id = %s FOR UPDATE", (world_id,))
            world = cursor.fetchone()
            if world is None:
                raise StudioWorldMissingError()
            revision = world["current_revision"]
            if revision == 0:
                raise StudioWorldConflictError("There is no change to undo.")
            cursor.execute("SELECT before_state FROM studio_world_events WHERE world_id = %s AND revision = %s", (world_id, revision))
            event = cursor.fetchone()
            if event is None:
                raise StudioWorldConflictError("The world timeline is incomplete.")
            cursor.execute(
                f"""UPDATE studio_worlds SET state = %s, current_revision = %s, updated_at = NOW()
                    WHERE id = %s RETURNING {STUDIO_WORLD_COLUMNS}""",
                (Jsonb(event["before_state"]), revision - 1, world_id),
            )
            row = cursor.fetchone()
    if row is None:
        raise StudioWorldMissingError()
    return world_from_row(row)


def redo(world_id: UUID) -> StudioWorld:
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(f"SELECT {STUDIO_WORLD_COLUMNS} FROM studio_worlds WHERE id = %s FOR UPDATE", (world_id,))
            world = cursor.fetchone()
            if world is None:
                raise StudioWorldMissingError()
            next_revision = world["current_revision"] + 1
            cursor.execute("SELECT after_state FROM studio_world_events WHERE world_id = %s AND revision = %s", (world_id, next_revision))
            event = cursor.fetchone()
            if event is None:
                raise StudioWorldConflictError("There is no change to redo.")
            cursor.execute(
                f"""UPDATE studio_worlds SET state = %s, current_revision = %s, updated_at = NOW()
                    WHERE id = %s RETURNING {STUDIO_WORLD_COLUMNS}""",
                (Jsonb(event["after_state"]), next_revision, world_id),
            )
            row = cursor.fetchone()
    if row is None:
        raise StudioWorldMissingError()
    return world_from_row(row)


def get_snapshot(world_id: UUID, revision: int) -> dict[str, Any] | None:
    world = get_world(world_id)
    if world is None:
        return None
    if revision == 0:
        return world.initial_state
    with connect() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("SELECT after_state FROM studio_world_events WHERE world_id = %s AND revision = %s", (world_id, revision))
            event = cursor.fetchone()
    return event["after_state"] if event else None
