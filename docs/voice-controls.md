# Voice controls

Hold **Hold to talk**, speak an English command, then release the button. The game transcribes that recording with Deepgram and applies valid commands immediately.

## Commands

- `Change world to <scene direction>` replaces the current scene direction. Example: `Change world to a rainy neon city`.
- Any other phrase sends one one-shot action for the next game beat. Examples: `pick up a battle axe`, `Action pick up a battle axe`, and `Action: pick up a battle axe`.

Only scene changes require the `Change world to` phrase, preventing an ordinary action from permanently replacing the world direction.

## Privacy and troubleshooting

The browser requests microphone permission only when you hold the button. The recording is sent directly to this app's FastAPI server, which forwards it to Deepgram for transcription; the app does not save recordings. Keep `DEEPGRAM_API_KEY` in `backend/.env` and never place it in frontend environment variables.

If recording is unavailable, check browser microphone permission. If transcription fails, confirm the backend is running and `DEEPGRAM_API_KEY` is configured.
