import unittest
from datetime import UTC, datetime

from backend.app.repositories.studio_worlds import StudioWorldEvent
from backend.app.services import world_studio


class WorldStudioTest(unittest.TestCase):
    def test_commands_keep_a_consistent_structured_world(self) -> None:
        state = world_studio.initial_state("A rainy futuristic city with neon lights.")
        state = world_studio.apply_command(state, "Add Alice").state
        state = world_studio.apply_command(state, "Give Alice a red motorcycle").state
        state = world_studio.apply_command(state, "Move Alice to the bridge").state
        state = world_studio.apply_command(state, "Make it rain").state

        self.assertEqual(state["characters"]["Alice"]["location"], "Bridge")
        self.assertEqual(state["objects"]["Motorcycle"]["owner"], "Alice")
        self.assertEqual(state["objects"]["Motorcycle"]["color"], "red")
        self.assertEqual(state["objects"]["Motorcycle"]["location"], "Bridge")
        self.assertEqual(state["environment"]["weather"], "rain")
        self.assertIn("Alice", state["locations"]["Bridge"]["characters"])
        self.assertIn("Motorcycle", state["locations"]["Bridge"]["objects"])

    def test_queries_and_render_prompt_read_the_current_state(self) -> None:
        state = world_studio.initial_state("A cyberpunk city")
        state = world_studio.apply_command(state, "Add Alice").state
        state = world_studio.apply_command(state, "Give Alice sunglasses").state
        state = world_studio.apply_command(state, "Move Alice to the cafe").state
        state = world_studio.apply_command(state, "Add Bob").state
        state = world_studio.apply_command(state, "Alice meets Bob").state
        events = [StudioWorldEvent(1, "Add Alice", "Alice was added to the world.", datetime.now(UTC))]

        self.assertEqual(world_studio.answer_query(state, events, "Where is Alice?"), "Alice is in Cafe.")
        self.assertEqual(world_studio.answer_query(state, events, "Who owns the sunglasses?"), "Sunglasses is owned by Alice.")
        self.assertEqual(world_studio.answer_query(state, events, "What objects are inside the cafe?"), "Cafe contains Sunglasses.")
        self.assertEqual(world_studio.answer_query(state, events, "Who has interacted with Bob?"), "Bob has interacted with Alice.")
        prompt = world_studio.render_prompt(state, "A cyberpunk city.", "cinematic")
        self.assertIn("Alice at Cafe", prompt)
        self.assertNotIn("..", prompt)
        self.assertIn("POV shot from Alice", world_studio.render_prompt(state, "A cyberpunk city", "character", "alice"))


if __name__ == "__main__":
    unittest.main()
