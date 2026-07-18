import io
import unittest
from datetime import UTC, datetime
from unittest.mock import patch
from uuid import uuid4

from PIL import Image
import psycopg

from backend.app.services import gallery


def png_bytes() -> bytes:
    data = io.BytesIO()
    Image.new("RGB", (2, 2), "green").save(data, format="PNG")
    return data.getvalue()


class GalleryValidationTest(unittest.TestCase):
    def test_validates_png_and_round_trips_cursor(self) -> None:
        image = gallery.validate_image(png_bytes())
        self.assertEqual((image.content_type, image.extension), ("image/png", "png"))
        created_at = datetime.now(UTC)
        world_id = uuid4()
        self.assertEqual(gallery.decode_cursor(gallery.encode_cursor(created_at, world_id)), (created_at, world_id))

    def test_save_removes_image_when_database_insert_fails(self) -> None:
        image = gallery.ValidatedImage("image/png", "png")
        with (
            patch.object(gallery, "put_image"),
            patch.object(gallery.worlds, "create_world", side_effect=psycopg.OperationalError()),
            patch.object(gallery, "delete_image") as delete_image,
        ):
            with self.assertRaises(gallery.GalleryError):
                gallery.save_world("play", "A test world", 42, png_bytes(), "test.png", image)
        delete_image.assert_called_once()


if __name__ == "__main__":
    unittest.main()
