from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response

from ..schemas import WorldPage, WorldResponse
from ...domain.worlds import World, WorldMode
from ...services.gallery import (
    GalleryError,
    GalleryValidationError,
    InvalidCursorError,
    get_world,
    get_world_image,
    list_worlds,
    save_world,
    validate_image,
)

router = APIRouter(prefix="/api/worlds", tags=["worlds"])


def world_response(world: World, request: Request) -> WorldResponse:
    return WorldResponse(
        id=world.id,
        mode=world.mode,
        prompt=world.prompt,
        seed=world.seed,
        image_url=str(request.url_for("read_world_image", world_id=str(world.id))),
        created_at=world.created_at,
    )


@router.post("", response_model=WorldResponse, status_code=status.HTTP_201_CREATED)
async def create_world(
    request: Request,
    mode: WorldMode = Form(),
    prompt: str = Form(max_length=2_000),
    seed: int = Form(ge=0, le=2_000_000_000),
    image: UploadFile = File(),
) -> WorldResponse:
    prompt = prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="Give the world a prompt before saving it.")
    try:
        image_data = await image.read(10 * 1024 * 1024 + 1)
        validated_image = validate_image(image_data)
    except GalleryValidationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    filename = Path(image.filename or f"reference.{validated_image.extension}").name
    try:
        world = await asyncio.to_thread(save_world, mode, prompt, seed, image_data, filename, validated_image)
    except GalleryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return world_response(world, request)

@router.get("", response_model=WorldPage)
async def read_worlds(
    request: Request,
    mode: WorldMode | None = None,
    limit: int = Query(default=24, ge=1, le=48),
    cursor: str | None = None,
) -> WorldPage:
    try:
        saved_worlds, next_cursor = await asyncio.to_thread(list_worlds, mode, limit, cursor)
    except InvalidCursorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except GalleryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return WorldPage(items=[world_response(world, request) for world in saved_worlds], next_cursor=next_cursor)


@router.get("/{world_id}", response_model=WorldResponse)
async def read_world(world_id: UUID, request: Request) -> WorldResponse:
    try:
        world = await asyncio.to_thread(get_world, world_id)
    except GalleryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if world is None:
        raise HTTPException(status_code=404, detail="This saved world does not exist.")
    return world_response(world, request)


@router.get("/{world_id}/image", name="read_world_image")
async def read_world_image(world_id: UUID) -> Response:
    try:
        result = await asyncio.to_thread(get_world_image, world_id)
    except GalleryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="This saved world does not exist.")
    world, image_data = result
    return Response(content=image_data, media_type=world.image_content_type)
