import assert from "node:assert/strict";
import test from "node:test";
import { appRouteFromPath, buildSharedSceneUrl, parseSharedScene, pathForAppRoute } from "../.share-test/share-scene.js";

test("shares and restores a mode and prompt without dropping other URL parameters", () => {
  const url = buildSharedSceneUrl("https://demo.example/?source=invite", { mode: "watch", prompt: "Moonlit ruins" });
  assert.deepEqual(parseSharedScene(new URL(url).search), { mode: "watch", prompt: "Moonlit ruins" });
  assert.equal(new URL(url).searchParams.get("source"), "invite");
  assert.equal(parseSharedScene("?mode=play&prompt=%20%20"), null);
  assert.deepEqual(parseSharedScene("?mode=edit&prompt=make%20it%20clay"), { mode: "edit", prompt: "make it clay" });
});

test("maps landing entry paths", () => {
  assert.equal(appRouteFromPath("/"), "landing");
  assert.equal(appRouteFromPath("/get-started"), "choose");
  assert.equal(appRouteFromPath("/studio"), "studio");
  assert.equal(appRouteFromPath("/missing"), "landing");
  assert.equal(pathForAppRoute("landing"), "/");
  assert.equal(pathForAppRoute("choose"), "/get-started");
  assert.equal(pathForAppRoute("studio"), "/studio");
});
