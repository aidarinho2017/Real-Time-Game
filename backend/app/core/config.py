from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


@dataclass(frozen=True)
class Settings:
    reactor_tokens_url: str
    deepgram_listen_url: str
    cors_origins: list[str]
    reactor_api_key: str | None
    deepgram_api_key: str | None
    database_url: str
    s3_endpoint_url: str
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    s3_region: str


def get_settings() -> Settings:
    origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    return Settings(
        reactor_tokens_url="https://api.reactor.inc/tokens",
        deepgram_listen_url="https://api.deepgram.com/v1/listen",
        cors_origins=[origin.strip() for origin in origins.split(",") if origin.strip()],
        reactor_api_key=os.getenv("REACTOR_API_KEY"),
        deepgram_api_key=os.getenv("DEEPGRAM_API_KEY"),
        database_url=os.getenv("DATABASE_URL", "postgresql://living_worlds:living_worlds@127.0.0.1:5432/living_worlds"),
        s3_endpoint_url=os.getenv("S3_ENDPOINT_URL", "http://127.0.0.1:9000"),
        s3_bucket=os.getenv("S3_BUCKET", "living-worlds"),
        s3_access_key=os.getenv("S3_ACCESS_KEY", "minioadmin"),
        s3_secret_key=os.getenv("S3_SECRET_KEY", "minioadmin"),
        s3_region=os.getenv("S3_REGION", "us-east-1"),
    )
