from __future__ import annotations

from typing import Any

import httpx

from ..core.config import get_settings


class ReactorError(RuntimeError):
    def __init__(self, status_code: int, detail: Any):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


async def issue_token() -> str:
    settings = get_settings()
    if not settings.reactor_api_key:
        raise ReactorError(503, "REACTOR_API_KEY is not configured")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(settings.reactor_tokens_url, headers={"Reactor-API-Key": settings.reactor_api_key})
    except httpx.HTTPError as exc:
        raise ReactorError(502, "Could not reach Reactor") from exc

    if response.is_error:
        detail: Any = "Reactor rejected the token request"
        try:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("detail"):
                detail = payload["detail"]
        except ValueError:
            pass
        raise ReactorError(502, detail)
    try:
        jwt = response.json()["jwt"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ReactorError(502, "Reactor returned an invalid token response") from exc
    if not isinstance(jwt, str) or not jwt:
        raise ReactorError(502, "Reactor returned an empty token")
    return jwt
