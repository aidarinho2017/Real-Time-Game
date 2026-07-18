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

    def test_save_edit_keeps_only_output_and_reference_images(self) -> None:
        output = gallery.ValidatedImage("image/png", "png")
        reference = gallery.ValidatedImage("image/png", "png")
        saved_world = object()
        with (
            patch.object(gallery, "put_image") as put_image,
            patch.object(gallery.worlds, "create_world", return_value=saved_world) as create_world,
        ):
            result = gallery.save_world(
                "edit", "Make it clay", 42, png_bytes(), "output.png", output,
                "video", True, png_bytes(), "character.png", reference,
            )
        self.assertIs(result, saved_world)
        self.assertEqual(put_image.call_count, 2)
        self.assertEqual(create_world.call_args.args[1:4], ("edit", "Make it clay", 42))


if __name__ == "__main__":
    unittest.main()
