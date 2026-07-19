from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from ...repositories import studio_worlds
from ...services import world_studio
from ..schemas import (
    StudioWorldCommand,
    StudioWorldCreate,
    StudioWorldEventResponse,
    StudioWorldListItem,
    StudioWorldQuery,
    StudioWorldQueryResponse,
    StudioWorldRenderRequest,
    StudioWorldRenderResponse,
    StudioWorldResponse,
    StudioWorldStateUpdate,
)

router = APIRouter(prefix="/api/studio-worlds", tags=["studio-worlds"])


def response(world: studio_worlds.StudioWorld, events: list[studio_worlds.StudioWorldEvent] | None = None) -> StudioWorldResponse:
    return StudioWorldResponse(
        id=world.id,
        name=world.name,
        description=world.description,
        initial_prompt=world.initial_prompt,
        state=world.state,
        current_revision=world.current_revision,
        created_at=world.created_at,
        updated_at=world.updated_at,
        events=[StudioWorldEventResponse(**event.__dict__) for event in (events or [])],
    )


def fail(error: Exception) -> None:
    if isinstance(error, world_studio.WorldStudioValidationError):
        raise HTTPException(status_code=422, detail=str(error)) from error
    raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("", response_model=StudioWorldResponse, status_code=status.HTTP_201_CREATED)
async def create_world(payload: StudioWorldCreate) -> StudioWorldResponse:
    try:
        return response(world_studio.create_world(payload.name, payload.description, payload.initial_prompt))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.get("", response_model=list[StudioWorldListItem])
async def read_worlds(limit: int = Query(default=24, ge=1, le=100)) -> list[StudioWorldListItem]:
    try:
        worlds = studio_worlds.list_worlds(limit)
    except Exception as exc:
        fail(world_studio.WorldStudioError("Could not load saved worlds."))
    return [StudioWorldListItem(id=world.id, name=world.name, description=world.description, current_revision=world.current_revision, updated_at=world.updated_at) for world in worlds]


@router.get("/{world_id}", response_model=StudioWorldResponse)
async def read_world(world_id: UUID) -> StudioWorldResponse:
    try:
        world = world_studio.get_world_or_raise(world_id)
        return response(world, world_studio.world_events(world_id))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.get("/{world_id}/state")
async def read_world_state(world_id: UUID) -> dict[str, Any]:
    try:
        return world_studio.get_world_or_raise(world_id).state
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.put("/{world_id}/state", response_model=StudioWorldResponse)
async def update_world_state(world_id: UUID, payload: StudioWorldStateUpdate) -> StudioWorldResponse:
    try:
        world = world_studio.replace_state(world_id, payload.state)
        return response(world, world_studio.world_events(world_id))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.post("/{world_id}/commands", response_model=StudioWorldResponse)
async def run_command(world_id: UUID, payload: StudioWorldCommand) -> StudioWorldResponse:
    try:
        world = world_studio.change_world(world_id, payload.command)
        return response(world, world_studio.world_events(world_id))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.post("/{world_id}/undo", response_model=StudioWorldResponse)
async def undo(world_id: UUID) -> StudioWorldResponse:
    try:
        world = world_studio.undo(world_id)
        return response(world, world_studio.world_events(world_id))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.post("/{world_id}/redo", response_model=StudioWorldResponse)
async def redo(world_id: UUID) -> StudioWorldResponse:
    try:
        world = world_studio.redo(world_id)
        return response(world, world_studio.world_events(world_id))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.get("/{world_id}/revisions/{revision}")
async def replay(world_id: UUID, revision: int) -> dict[str, Any]:
    try:
        return world_studio.snapshot(world_id, revision)
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.post("/{world_id}/query", response_model=StudioWorldQueryResponse)
async def query_world(world_id: UUID, payload: StudioWorldQuery) -> StudioWorldQueryResponse:
    try:
        world = world_studio.get_world_or_raise(world_id)
        return StudioWorldQueryResponse(answer=world_studio.answer_query(world.state, world_studio.world_events(world_id), payload.question))
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)


@router.post("/{world_id}/render-prompt", response_model=StudioWorldRenderResponse)
async def render_world(world_id: UUID, payload: StudioWorldRenderRequest) -> StudioWorldRenderResponse:
    try:
        world = world_studio.get_world_or_raise(world_id)
        state = world_studio.snapshot(world_id, payload.event_revision) if payload.shot == "event" and payload.event_revision is not None else world.state
        return StudioWorldRenderResponse(prompt=world_studio.render_prompt(state, world.initial_prompt, payload.shot, payload.character), state=state)
    except (world_studio.WorldStudioError, world_studio.WorldStudioValidationError) as exc:
        fail(exc)
