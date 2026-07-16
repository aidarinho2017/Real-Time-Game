import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceCommand } from "../.voice-test/voice-command.js";

test("routes natural speech to actions and reserves scene changes for their prefix", () => {
  assert.deepEqual(parseVoiceCommand("Action play football"), { kind: "action", value: "play football" });
  assert.deepEqual(parseVoiceCommand("play football"), { kind: "action", value: "play football" });
  assert.deepEqual(parseVoiceCommand("Change world to snowy ruins"), { kind: "scene", value: "snowy ruins" });
  assert.equal(parseVoiceCommand("   "), null);
});
