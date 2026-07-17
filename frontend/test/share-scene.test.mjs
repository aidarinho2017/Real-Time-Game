import assert from "node:assert/strict";
import test from "node:test";
import { buildSharedSceneUrl, parseSharedScene } from "../.share-test/share-scene.js";

test("shares and restores a mode and prompt without dropping other URL parameters", () => {
  const url = buildSharedSceneUrl("https://demo.example/?source=invite", { mode: "watch", prompt: "Moonlit ruins" });
  assert.deepEqual(parseSharedScene(new URL(url).search), { mode: "watch", prompt: "Moonlit ruins" });
  assert.equal(new URL(url).searchParams.get("source"), "invite");
  assert.equal(parseSharedScene("?mode=play&prompt=%20%20"), null);
});
