# Living Worlds roadmap

This roadmap favors the smallest client-side changes that make a desktop or kiosk demo feel immediate, cinematic, and worth sharing.

## Shipped

- Prompt presets with visual thumbnails in Play and Watch setup.
- Browser JPEG snapshots, including a clear unavailable state before the first frame.
- Watch duration and `$6/hour` estimate disclosure with an active countdown.
- First-run movement, voice, and movie-direction guidance.

- Featured worlds that immediately start Play with the matching prompt and bundled Reactor reference image.
- Native Theater mode for unobstructed fullscreen Play and Watch.
- Scene sharing through the native share sheet or clipboard; Watch restores setup and Play launches the shared prompt.
- In-app confirmation after a snapshot download.

## Next

### Kiosk handoff

Return an inactive or completed demo to the landing screen after a short, visible countdown.

- **Visitor value:** each new visitor inherits a clean, inviting first screen.
- **Scope:** client-side idle timer only; never interrupt active input, recording, or generation.

### Presenter-safe reset

Add one action that returns the app to its default world and closes any fullscreen state.

- **Visitor value:** a presenter can recover instantly between visitors.
- **Scope:** reset local UI and the active model session; no new server route.

## Later

- Mobile/touch movement controls after desktop and kiosk usage proves the need.
- Privacy-safe aggregate telemetry after a destination and privacy policy are selected.
- Local settings persistence or cloud history only if return usage justifies it.
