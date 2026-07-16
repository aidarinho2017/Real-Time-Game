export type VoiceCommand =
  | { kind: "scene"; value: string }
  | { kind: "action"; value: string };

export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const spokenCommand = transcript.trim();
  if (!spokenCommand) return null;

  const scene = spokenCommand.match(/^change\s+world\s+to\s+(.+?)\s*$/i);
  if (scene?.[1]) return { kind: "scene", value: scene[1] };

  return { kind: "action", value: spokenCommand.replace(/^action(?:\s*:\s*|\s+)/i, "") || spokenCommand };
}
