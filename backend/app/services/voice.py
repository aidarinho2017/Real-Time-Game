from __future__ import annotations

import httpx

from ..core.config import get_settings

MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024


class VoiceError(RuntimeError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def transcribe_audio(content_type: str, content_length: str | None, audio: bytes) -> str:
    settings = get_settings()
    if not settings.deepgram_api_key:
        raise VoiceError(503, "DEEPGRAM_API_KEY is not configured")
    if not content_type.lower().startswith("audio/"):
        raise VoiceError(415, "Send an audio recording.")
    if content_length and content_length.isdigit() and int(content_length) > MAX_VOICE_AUDIO_BYTES:
        raise VoiceError(413, "Voice recordings must be 10 MB or smaller.")
    if not audio:
        raise VoiceError(422, "The voice recording was empty.")
    if len(audio) > MAX_VOICE_AUDIO_BYTES:
        raise VoiceError(413, "Voice recordings must be 10 MB or smaller.")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                settings.deepgram_listen_url,
                params={"model": "nova-3", "language": "en", "smart_format": "true"},
                headers={"Authorization": f"Token {settings.deepgram_api_key}", "Content-Type": content_type},
                content=audio,
            )
    except httpx.HTTPError as exc:
        raise VoiceError(502, "Could not reach Deepgram.") from exc
    if response.is_error:
        raise VoiceError(502, "Deepgram could not transcribe the recording.")
    try:
        transcript = response.json()["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise VoiceError(502, "Deepgram returned an invalid transcription response.") from exc
    if not isinstance(transcript, str) or not transcript.strip():
        raise VoiceError(422, "No speech was recognized. Try again.")
    return transcript.strip()
