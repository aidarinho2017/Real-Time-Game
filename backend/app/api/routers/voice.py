from fastapi import APIRouter, HTTPException, Request

from ..schemas import VoiceTranscriptResponse
from ...services.voice import VoiceError, transcribe_audio

router = APIRouter(prefix="/api/voice", tags=["voice"])


@router.post("/transcribe", response_model=VoiceTranscriptResponse)
async def transcribe_voice(request: Request) -> VoiceTranscriptResponse:
    try:
        transcript = await transcribe_audio(
            request.headers.get("content-type", ""),
            request.headers.get("content-length"),
            await request.body(),
        )
    except VoiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return VoiceTranscriptResponse(transcript=transcript)
