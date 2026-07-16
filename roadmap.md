# Living Worlds roadmap

This roadmap is ordered by visitor impact per unit of implementation effort. It favors client-side additions that reuse the existing Reactor, Deepgram, and browser capabilities.

## Now

### 1. Prompt presets

Add a small set of scene and movie templates that fill the existing prompt fields without automatically starting or resetting a session.

- **Visitor value:** removes blank-page friction and makes the demo immediately explorable.
- **Scope:** static prompt chips/cards only; no prompt-generation service.
- **Done when:** Play and Watch setup each offer 4–6 distinct presets that populate the relevant textarea.

### 2. Snapshot download

Add a button in Play and Watch that saves the currently visible video frame as a JPEG in the browser.

- **Visitor value:** gives every successful session a shareable outcome.
- **Scope:** client-side capture/download only; no gallery, account, or upload service.
- **Done when:** the current frame downloads with a descriptive filename and a clear unavailable state before video arrives.

### 3. Clear Watch budget disclosure

Show the Watch duration and estimated credit usage before starting Helios, then keep the remaining session time visible during playback.

- **Visitor value:** makes the premium stream feel intentional rather than abruptly interrupted.
- **Scope:** presentation based on configured limits; no billing integration.
- **Done when:** setup explains the two-minute default and active Watch shows its countdown.

### 4. First-run guidance

Add concise contextual hints: movement keys in Play, natural voice examples, and one sentence explaining the Watch setup image/prompt.

- **Visitor value:** reduces hesitation without a long tutorial.
- **Scope:** inline copy only, dismissible only if needed after usability testing.
- **Done when:** a new visitor can discover movement, voice, and movie direction without documentation.

## Next

### Remember local settings

Persist the last Play and Watch prompts in browser storage, plus image names only (not image data).

- **Visitor value:** makes a return visit feel continuous without introducing accounts.
- **Scope:** local browser storage; no cross-device sync or cloud session history.

### Share prompt links

Add a share action that encodes the active prompt and selected mode in the URL.

- **Visitor value:** lets visitors reproduce an idea with one link.
- **Scope:** prompt and mode only; uploaded images are deliberately excluded.

### Privacy-safe telemetry

Add aggregate events for mode selection, first frame, snapshot, error category, and session completion after an analytics destination and privacy policy are selected.

- **Visitor value:** helps improve the demo using real friction data.
- **Scope:** no transcript, prompt text, image, or raw video capture.
