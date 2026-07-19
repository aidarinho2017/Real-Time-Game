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

CREATE TABLE IF NOT EXISTS studio_worlds (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    initial_prompt TEXT NOT NULL,
    initial_state JSONB NOT NULL,
    state JSONB NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS studio_world_events (
    id UUID PRIMARY KEY,
    world_id UUID NOT NULL REFERENCES studio_worlds(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    command TEXT NOT NULL,
    summary TEXT NOT NULL,
    before_state JSONB NOT NULL,
    after_state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (world_id, revision)
);
CREATE INDEX IF NOT EXISTS studio_world_events_world_revision_idx ON studio_world_events (world_id, revision);
"""


def connect() -> psycopg.Connection:
    return psycopg.connect(get_settings().database_url)


def initialize_database() -> None:
    with connect() as connection:
        connection.execute(SCHEMA)
