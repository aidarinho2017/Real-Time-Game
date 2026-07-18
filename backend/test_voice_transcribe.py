import asyncio
import os
import unittest

from backend.app.services import voice


class FakeDeepgramClient:
    async def __aenter__(self) -> "FakeDeepgramClient":
        return self

    async def __aexit__(self, *args: object) -> bool:
        return False

    async def post(self, *args: object, **kwargs: object) -> voice.httpx.Response:
        return voice.httpx.Response(200, json={"results": {"channels": [{"alternatives": [{"transcript": " Action: jump "}]}]}})


class VoiceTranscriptionTest(unittest.TestCase):
    def test_transcription_is_trimmed(self) -> None:
        original_client = voice.httpx.AsyncClient
        original_key = os.environ.get("DEEPGRAM_API_KEY")
        voice.httpx.AsyncClient = lambda *args, **kwargs: FakeDeepgramClient()
        os.environ["DEEPGRAM_API_KEY"] = "test-key"
        try:
            result = asyncio.run(voice.transcribe_audio("audio/webm", None, b"voice"))
        finally:
            voice.httpx.AsyncClient = original_client
            if original_key is None:
                os.environ.pop("DEEPGRAM_API_KEY", None)
            else:
                os.environ["DEEPGRAM_API_KEY"] = original_key

        self.assertEqual(result, "Action: jump")


if __name__ == "__main__":
    unittest.main()
