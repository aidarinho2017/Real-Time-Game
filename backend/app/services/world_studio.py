from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg

from ..repositories import studio_worlds

ENVIRONMENT_FIELDS = ("weather", "time", "lighting", "temperature", "season")
COLORS = "red|blue|green|yellow|black|white|silver|gold|purple|pink|orange|brown|gray|grey"


class WorldStudioError(RuntimeError):
    pass


class WorldStudioValidationError(ValueError):
    pass


@dataclass(frozen=True)
class CommandResult:
    state: dict[str, Any]
    summary: str


def _display_name(value: str) -> str:
    value = re.sub(r"\s+", " ", value.strip().removesuffix(".").removesuffix("!"))
    value = re.sub(r"^(?:the|a|an)\s+", "", value, flags=re.IGNORECASE)
    return value[:1].upper() + value[1:]


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _record_key(records: dict[str, Any], name: str) -> str | None:
    wanted = _key(_display_name(name))
    return next((record_key for record_key, record in records.items() if _key(record_key) == wanted or (isinstance(record, dict) and _key(str(record.get("name", ""))) == wanted)), None)


def _string(value: Any, field: str, default: str = "") -> str:
    if value is None:
        return default
    if not isinstance(value, str):
        raise WorldStudioValidationError(f"{field} must be text.")
    return value.strip()[:500]


def _text_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise WorldStudioValidationError(f"{field} must be a list of names.")
    return [item.strip()[:120] for item in value if item.strip()][:100]


def normalize_state(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise WorldStudioValidationError("World state must be a JSON object.")
    raw_environment = raw.get("environment", {})
    if not isinstance(raw_environment, dict):
        raise WorldStudioValidationError("environment must be an object.")
    environment = {field: _string(raw_environment.get(field), f"environment.{field}", "unspecified") for field in ENVIRONMENT_FIELDS}

    def records(field: str) -> dict[str, dict[str, Any]]:
        value = raw.get(field, {})
        if not isinstance(value, dict):
            raise WorldStudioValidationError(f"{field} must be an object keyed by name.")
        if len(value) > 100:
            raise WorldStudioValidationError(f"{field} may contain at most 100 entries.")
        if not all(isinstance(key, str) and isinstance(item, dict) for key, item in value.items()):
            raise WorldStudioValidationError(f"{field} entries must be named objects.")
        return value

    characters: dict[str, dict[str, Any]] = {}
    for key, value in records("characters").items():
        name = _display_name(_string(value.get("name"), f"characters.{key}.name", key))
        relationships = value.get("relationships", {})
        if not isinstance(relationships, dict) or not all(isinstance(partner, str) and isinstance(status, str) for partner, status in relationships.items()):
            raise WorldStudioValidationError(f"characters.{key}.relationships must map names to text.")
        characters[name] = {
            "name": name,
            "age": value.get("age"),
            "appearance": _string(value.get("appearance"), f"characters.{key}.appearance"),
            "emotion": _string(value.get("emotion"), f"characters.{key}.emotion", "neutral"),
            "inventory": _text_list(value.get("inventory"), f"characters.{key}.inventory"),
            "location": _display_name(_string(value.get("location"), f"characters.{key}.location")) if value.get("location") else "",
            "action": _string(value.get("action"), f"characters.{key}.action", "idle"),
            "relationships": {partner.strip()[:120]: status.strip()[:240] for partner, status in relationships.items() if partner.strip() and status.strip()},
        }

    objects: dict[str, dict[str, Any]] = {}
    for key, value in records("objects").items():
        name = _display_name(_string(value.get("name"), f"objects.{key}.name", key))
        properties = value.get("properties", {})
        if not isinstance(properties, dict):
            raise WorldStudioValidationError(f"objects.{key}.properties must be an object.")
        objects[name] = {
            "name": name,
            "color": _string(value.get("color"), f"objects.{key}.color"),
            "owner": _display_name(_string(value.get("owner"), f"objects.{key}.owner")) if value.get("owner") else "",
            "location": _display_name(_string(value.get("location"), f"objects.{key}.location")) if value.get("location") else "",
            "state": _string(value.get("state"), f"objects.{key}.state", "available"),
            "properties": properties,
        }

    locations: dict[str, dict[str, Any]] = {}
    for key, value in records("locations").items():
        name = _display_name(_string(value.get("name"), f"locations.{key}.name", key))
        locations[name] = {
            "name": name,
            "objects": _text_list(value.get("objects"), f"locations.{key}.objects"),
            "characters": _text_list(value.get("characters"), f"locations.{key}.characters"),
            "environment": value.get("environment", {}),
        }

    for character in characters.values():
        if character["location"] and character["location"] not in locations:
            locations[character["location"]] = {"name": character["location"], "objects": [], "characters": [], "environment": {}}
        if character["location"] and character["name"] not in locations[character["location"]]["characters"]:
            locations[character["location"]]["characters"].append(character["name"])
    for object_ in objects.values():
        if object_["location"] and object_["location"] not in locations:
            locations[object_["location"]] = {"name": object_["location"], "objects": [], "characters": [], "environment": {}}
        if object_["location"] and object_["name"] not in locations[object_["location"]]["objects"]:
            locations[object_["location"]]["objects"].append(object_["name"])
    return {"characters": characters, "objects": objects, "locations": locations, "environment": environment}


def initial_state(initial_prompt: str) -> dict[str, Any]:
    prompt = initial_prompt.casefold()
    weather = "rain" if "rain" in prompt or "storm" in prompt else "clear"
    lighting = "neon" if "neon" in prompt else "natural"
    return normalize_state({"characters": {}, "objects": {}, "locations": {}, "environment": {"weather": weather, "time": "unspecified", "lighting": lighting, "temperature": "unspecified", "season": "unspecified"}})


def _character(state: dict[str, Any], name: str) -> tuple[str, dict[str, Any]]:
    key = _record_key(state["characters"], name)
    if key is None:
        raise WorldStudioValidationError(f"{_display_name(name)} does not exist yet. Add the character first.")
    return key, state["characters"][key]


def _location(state: dict[str, Any], name: str) -> tuple[str, dict[str, Any]]:
    display = _display_name(name)
    key = _record_key(state["locations"], display)
    if key is None:
        state["locations"][display] = {"name": display, "objects": [], "characters": [], "environment": {}}
        return display, state["locations"][display]
    return key, state["locations"][key]


def _move_character(state: dict[str, Any], character_name: str, location_name: str) -> str:
    _, character = _character(state, character_name)
    for location in state["locations"].values():
        location["characters"] = [name for name in location["characters"] if _key(name) != _key(character["name"])]
    location_key, location = _location(state, location_name)
    character["location"] = state["locations"][location_key]["name"]
    location["characters"].append(character["name"])
    for object_ in state["objects"].values():
        if object_["owner"] == character["name"] and object_["name"] in character["inventory"]:
            object_["location"] = character["location"]
    return character["location"]


def apply_command(current_state: dict[str, Any], command: str) -> CommandResult:
    command = command.strip()
    if not command:
        raise WorldStudioValidationError("Write a world command first.")
    state = copy.deepcopy(normalize_state(current_state))
    text = command.removesuffix(".").strip()

    match = re.fullmatch(r"(?:add|create)\s+([A-Za-z][\w' -]{0,80})", text, flags=re.IGNORECASE)
    if match:
        name = _display_name(match.group(1))
        if _record_key(state["characters"], name):
            raise WorldStudioValidationError(f"{name} already exists.")
        state["characters"][name] = {"name": name, "age": None, "appearance": "", "emotion": "neutral", "inventory": [], "location": "", "action": "idle", "relationships": {}}
        return CommandResult(state, f"{name} was added to the world.")

    match = re.fullmatch(r"give\s+([A-Za-z][\w'-]*)\s+(?:(?:a|an|the)\s+)?(?:(%s)\s+)?([A-Za-z][\w' -]{0,80})" % COLORS, text, flags=re.IGNORECASE)
    if match:
        _, character = _character(state, match.group(1))
        color = (match.group(2) or "").lower()
        item_name = _display_name(match.group(3))
        object_key = _record_key(state["objects"], item_name)
        if object_key is None:
            object_key = item_name
            state["objects"][object_key] = {"name": item_name, "color": color, "owner": character["name"], "location": character["location"], "state": "available", "properties": {}}
        else:
            state["objects"][object_key].update({"owner": character["name"], "location": character["location"]})
            if color:
                state["objects"][object_key]["color"] = color
        if item_name not in character["inventory"]:
            character["inventory"].append(item_name)
        return CommandResult(normalize_state(state), f"{character['name']} received the {color + ' ' if color else ''}{item_name}.")

    match = re.fullmatch(r"(?:move\s+)?([A-Za-z][\w'-]*)\s+(?:to|enters?)\s+(.+)", text, flags=re.IGNORECASE)
    if match:
        destination = _move_character(state, match.group(1), match.group(2))
        _, character = _character(state, match.group(1))
        return CommandResult(normalize_state(state), f"{character['name']} moved to {destination}.")

    match = re.fullmatch(r"([A-Za-z][\w'-]*)\s+(?:picks up|picked up)\s+(?:the\s+)?(.+)", text, flags=re.IGNORECASE)
    if match:
        _, character = _character(state, match.group(1))
        item_name = _display_name(match.group(2))
        object_key = _record_key(state["objects"], item_name)
        if object_key is None:
            state["objects"][item_name] = {"name": item_name, "color": "", "owner": character["name"], "location": character["location"], "state": "carried", "properties": {}}
        else:
            state["objects"][object_key].update({"owner": character["name"], "location": character["location"], "state": "carried"})
        if item_name not in character["inventory"]:
            character["inventory"].append(item_name)
        return CommandResult(normalize_state(state), f"{character['name']} picked up {item_name}.")

    match = re.fullmatch(r"([A-Za-z][\w'-]*)\s+(?:meets?|met|interacts? with)\s+([A-Za-z][\w'-]*)", text, flags=re.IGNORECASE)
    if match:
        _, first = _character(state, match.group(1))
        _, second = _character(state, match.group(2))
        first["relationships"][second["name"]] = "interacted"
        second["relationships"][first["name"]] = "interacted"
        return CommandResult(state, f"{first['name']} and {second['name']} interacted.")

    if re.search(r"\b(rain|raining)\b", text, flags=re.IGNORECASE):
        state["environment"]["weather"] = "rain"
        return CommandResult(state, "Rain started.")
    match = re.fullmatch(r"(?:make it|set (?:the )?weather to)\s+([A-Za-z -]+)", text, flags=re.IGNORECASE)
    if match:
        weather = match.group(1).strip().lower()
        state["environment"]["weather"] = weather
        return CommandResult(state, f"Weather changed to {weather}.")

    raise WorldStudioValidationError("Try “Add Alice”, “Give Alice a red motorcycle”, “Move Alice to the bridge”, or “Make it rain”.")


def answer_query(state: dict[str, Any], events: list[studio_worlds.StudioWorldEvent], question: str) -> str:
    state = normalize_state(state)
    question = question.strip().removesuffix("?")
    if not question:
        raise WorldStudioValidationError("Ask a question about this world first.")
    match = re.fullmatch(r"where is (.+)", question, flags=re.IGNORECASE)
    if match:
        _, character = _character(state, match.group(1))
        return f"{character['name']} is {('in ' + character['location']) if character['location'] else 'not placed in a location yet'}."
    match = re.fullmatch(r"who owns (?:the )?(.+)", question, flags=re.IGNORECASE)
    if match:
        key = _record_key(state["objects"], match.group(1))
        if key is None:
            return f"There is no { _display_name(match.group(1)) } in this world."
        owner = state["objects"][key]["owner"]
        return f"{state['objects'][key]['name']} is owned by {owner or 'nobody yet'}."
    if re.fullmatch(r"what changed recently", question, flags=re.IGNORECASE):
        if not events:
            return "Nothing has changed since this world was created."
        return " ".join(event.summary for event in events[-3:])
    match = re.fullmatch(r"what objects are (?:inside|in) (.+)", question, flags=re.IGNORECASE)
    if match:
        key = _record_key(state["locations"], match.group(1))
        if key is None:
            return f"There is no { _display_name(match.group(1)) } in this world."
        objects = state["locations"][key]["objects"]
        return f"{state['locations'][key]['name']} contains {', '.join(objects) if objects else 'no objects'}."
    match = re.fullmatch(r"who has interacted with (.+)", question, flags=re.IGNORECASE)
    if match:
        key, character = _character(state, match.group(1))
        names = [other["name"] for other_key, other in state["characters"].items() if other_key != key and (_record_key(other["relationships"], character["name"]) or _record_key(character["relationships"], other["name"]))]
        return f"{character['name']} has interacted with {', '.join(names) if names else 'no one yet'}."
    return f"This world has {len(state['characters'])} characters, {len(state['objects'])} objects, and {len(state['locations'])} locations. Ask where someone is, who owns an object, or what changed recently."


def render_prompt(state: dict[str, Any], initial_prompt: str, shot: str, character: str | None = None) -> str:
    state = normalize_state(state)
    if shot == "character":
        if not character:
            raise WorldStudioValidationError("Choose a character for a character-perspective render.")
        _, selected_character = _character(state, character)
        character = selected_character["name"]
    environment = ", ".join(f"{field}: {value}" for field, value in state["environment"].items() if value and value != "unspecified")
    characters = "; ".join(f"{item['name']} at {item['location'] or 'an unspecified location'}, {item['appearance'] or 'consistent appearance'}, {item['emotion']}" for item in state["characters"].values())
    objects = "; ".join(f"{item['color'] + ' ' if item['color'] else ''}{item['name']} owned by {item['owner'] or 'nobody'} at {item['location'] or 'an unspecified location'}" for item in state["objects"].values())
    shot_label = {"current": "current-world shot", "event": "event replay shot", "character": f"POV shot from {character or 'the selected character'}", "cinematic": "cinematic shot", "drone": "drone shot", "close-up": "close-up"}[shot]
    base_prompt = initial_prompt.strip().rstrip(".!?")
    return f"{shot_label}. {base_prompt}. World state: {environment or 'environment unchanged'}. Characters: {characters or 'none yet'}. Objects: {objects or 'none yet'}. Preserve every named character, object, ownership, and location exactly as described."


def create_world(name: str, description: str, prompt: str) -> studio_worlds.StudioWorld:
    name, description, prompt = name.strip(), description.strip(), prompt.strip()
    if not name or not prompt:
        raise WorldStudioValidationError("Give the world a name and an initial prompt.")
    if len(name) > 120 or len(description) > 2_000 or len(prompt) > 2_000:
        raise WorldStudioValidationError("Keep the name, description, and prompt within the stated limits.")
    try:
        return studio_worlds.create_world(name, description, prompt, initial_state(prompt))
    except psycopg.Error as exc:
        raise WorldStudioError("Could not create the world.") from exc


def change_world(world_id: UUID, command: str) -> studio_worlds.StudioWorld:
    world = get_world_or_raise(world_id)
    result = apply_command(world.state, command)
    return _save_change(world, command.strip(), result.summary, result.state)


def replace_state(world_id: UUID, state: dict[str, Any]) -> studio_worlds.StudioWorld:
    world = get_world_or_raise(world_id)
    state = normalize_state(state)
    if state == world.state:
        raise WorldStudioValidationError("The JSON state has no changes to save.")
    return _save_change(world, "Manual JSON edit", "World state was edited manually.", state)


def _save_change(world: studio_worlds.StudioWorld, command: str, summary: str, state: dict[str, Any]) -> studio_worlds.StudioWorld:
    try:
        return studio_worlds.add_change(world.id, world.current_revision, command, summary, world.state, state)
    except studio_worlds.StudioWorldConflictError as exc:
        raise WorldStudioValidationError(str(exc)) from exc
    except psycopg.Error as exc:
        raise WorldStudioError("Could not update the world.") from exc


def get_world_or_raise(world_id: UUID) -> studio_worlds.StudioWorld:
    try:
        world = studio_worlds.get_world(world_id)
    except psycopg.Error as exc:
        raise WorldStudioError("Could not load the world.") from exc
    if world is None:
        raise WorldStudioValidationError("This world does not exist.")
    return world


def list_worlds(limit: int) -> list[studio_worlds.StudioWorld]:
    try:
        return studio_worlds.list_worlds(limit)
    except psycopg.Error as exc:
        raise WorldStudioError("Could not load saved worlds.") from exc


def world_events(world_id: UUID) -> list[studio_worlds.StudioWorldEvent]:
    get_world_or_raise(world_id)
    try:
        return studio_worlds.list_events(world_id)
    except psycopg.Error as exc:
        raise WorldStudioError("Could not load the world timeline.") from exc


def undo(world_id: UUID) -> studio_worlds.StudioWorld:
    try:
        return studio_worlds.undo(world_id)
    except studio_worlds.StudioWorldMissingError as exc:
        raise WorldStudioValidationError("This world does not exist.") from exc
    except studio_worlds.StudioWorldConflictError as exc:
        raise WorldStudioValidationError(str(exc)) from exc
    except psycopg.Error as exc:
        raise WorldStudioError("Could not undo that change.") from exc


def redo(world_id: UUID) -> studio_worlds.StudioWorld:
    try:
        return studio_worlds.redo(world_id)
    except studio_worlds.StudioWorldMissingError as exc:
        raise WorldStudioValidationError("This world does not exist.") from exc
    except studio_worlds.StudioWorldConflictError as exc:
        raise WorldStudioValidationError(str(exc)) from exc
    except psycopg.Error as exc:
        raise WorldStudioError("Could not redo that change.") from exc


def snapshot(world_id: UUID, revision: int) -> dict[str, Any]:
    if revision < 0:
        raise WorldStudioValidationError("Timeline revisions cannot be negative.")
    try:
        state = studio_worlds.get_snapshot(world_id, revision)
    except psycopg.Error as exc:
        raise WorldStudioError("Could not replay that revision.") from exc
    if state is None:
        raise WorldStudioValidationError("That timeline revision does not exist.")
    return normalize_state(state)
