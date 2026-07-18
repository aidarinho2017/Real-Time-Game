import defaultWorldImage from "./assets/default-world.png";
import desertCrossingImage from "./assets/hf_20260714_201327_4d34829b-8cb0-427d-ac83-a20a07754611 (1).png";
import deepSpaceImage from "./assets/hf_20260715_083946_0e679c21-f161-4b2d-96ca-86c944cd27c6 (1).png";
import coastalEscapeImage from "./assets/hf_20260715_084119_303a7c2a-0566-4cf4-9292-c2c4e92a8f99 (1).png";
import lateNightPubImage from "./assets/hf_20260715_173503_5f255680-0d41-42d6-8bbb-3a226781b3ea.png";

export const DEFAULT_PROMPT =
  " bear walking in the city full of skycrapers, it should look like gta with the bear shown from backside";

export const DEFAULT_WORLD_IMAGE = defaultWorldImage;
export const DEFAULT_SESSION_SECONDS = 600;
export const DEFAULT_WATCH_SECONDS = 120;
export const HELIOS_DOLLARS_PER_HOUR = 6;
export const X2_DOLLARS_PER_HOUR = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;

export const PROMPT_PRESETS = [
  {
    name: "Desert crossing",
    image: desertCrossingImage,
    playPrompt: "A lone warrior walks through a sunlit desert oasis, palm trees and distant mountains ahead.",
    watchPrompt: "Cinematic tracking shot behind a lone warrior crossing a sunlit desert oasis, palms swaying and distant mountains glowing in the heat.",
  },
  {
    name: "Deep space",
    image: deepSpaceImage,
    playPrompt: "Pilot a small explorer ship through a colorful nebula between giant planets.",
    watchPrompt: "A cinematic explorer ship races through a colorful nebula between giant planets, starlight catching its engines.",
  },
  {
    name: "Coastal escape",
    image: coastalEscapeImage,
    playPrompt: "Ride a speedboat across a bright coastal bay toward a distant city at sunset.",
    watchPrompt: "A cinematic chase behind a speedboat cutting across a bright coastal bay toward a distant city at sunset.",
  },
  {
    name: "Late-night pub",
    image: lateNightPubImage,
    playPrompt: "Walk through a lively, warmly lit neighborhood pub at night.",
    watchPrompt: "A cinematic walk through a lively, warmly lit neighborhood pub at night, neon signs reflecting on the wooden floor.",
  },
];
