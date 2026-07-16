import asyncio
import os
import unittest

from starlette.requests import Request

from backend.app import main


def audio_request(body: bytes) -> Request:
    sent = False

    async def receive() -> dict[str, object]:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({"type": "http", "method": "POST", "headers": [(b"content-type", b"audio/webm")]}, receive)


class FakeDeepgramClient:
    async def __aenter__(self) -> "FakeDeepgramClient":
        return self

    async def __aexit__(self, *args: object) -> bool:
        return False

    async def post(self, *args: object, **kwargs: object) -> main.httpx.Response:
        return main.httpx.Response(200, json={"results": {"channels": [{"alternatives": [{"transcript": " Action: jump "}]}]}})


class VoiceTranscriptionTest(unittest.TestCase):
    def test_transcription_is_trimmed(self) -> None:
        original_client = main.httpx.AsyncClient
        original_key = os.environ.get("DEEPGRAM_API_KEY")
        main.httpx.AsyncClient = lambda *args, **kwargs: FakeDeepgramClient()
        os.environ["DEEPGRAM_API_KEY"] = "test-key"
        try:
            result = asyncio.run(main.transcribe_voice(audio_request(b"voice")))
        finally:
            main.httpx.AsyncClient = original_client
            if original_key is None:
                os.environ.pop("DEEPGRAM_API_KEY", None)
            else:
                os.environ["DEEPGRAM_API_KEY"] = original_key

        self.assertEqual(result.transcript, "Action: jump")


if __name__ == "__main__":
    unittest.main()
