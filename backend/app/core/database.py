from __future__ import annotations

import psycopg

from .config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
    id UUID PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('play', 'watch', 'edit')),
    prompt TEXT NOT NULL,
    seed BIGINT NOT NULL,
    image_key TEXT NOT NULL UNIQUE,
    image_filename TEXT NOT NULL,
    image_content_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_type TEXT,
    keep_backlog BOOLEAN,
    reference_image_key TEXT UNIQUE,
    reference_image_filename TEXT,
    reference_image_content_type TEXT
);
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS keep_backlog BOOLEAN;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reference_image_key TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reference_image_filename TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reference_image_content_type TEXT;
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_mode_check;
ALTER TABLE worlds ADD CONSTRAINT worlds_mode_check CHECK (mode IN ('play', 'watch', 'edit'));
CREATE INDEX IF NOT EXISTS worlds_created_at_id_idx ON worlds (created_at DESC, id DESC);
"""


def connect() -> psycopg.Connection:
    return psycopg.connect(get_settings().database_url)


def initialize_database() -> None:
    with connect() as connection:
        connection.execute(SCHEMA)
