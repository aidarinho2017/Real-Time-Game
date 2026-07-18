export type SharedSceneMode = "play" | "watch" | "edit";

export interface SharedScene {
  mode: SharedSceneMode;
  prompt: string;
}

export function parseSharedScene(search: string): SharedScene | null {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const prompt = params.get("prompt")?.trim();
  if ((mode !== "play" && mode !== "watch" && mode !== "edit") || !prompt) return null;
  return { mode, prompt };
}

export function buildSharedSceneUrl(href: string, scene: SharedScene): string {
  const url = new URL(href);
  url.searchParams.set("mode", scene.mode);
  url.searchParams.set("prompt", scene.prompt);
  return url.toString();
}
