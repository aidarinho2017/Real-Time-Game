from fastapi import APIRouter, HTTPException

from ..schemas import TokenResponse
from ...services.reactor import ReactorError, issue_token

router = APIRouter(prefix="/api/reactor", tags=["reactor"])


@router.post("/token", response_model=TokenResponse)
async def issue_reactor_token() -> TokenResponse:
    try:
        return TokenResponse(jwt=await issue_token())
    except ReactorError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
