# Living Worlds product brief

## Product

Living Worlds is a real-time AI experience for demo visitors. A visitor chooses one of two paths:

- **Play** — explore a generated world with keyboard movement, typed scene direction, and English voice actions.
- **Watch real-time movie** — direct a Helios movie with a prompt and optional image, then watch it unfold live.

The product's job is to make the first generated frame feel immediate, surprising, and understandable without an account or tutorial.

## Primary user

The first user is a curious demo visitor who wants to see what Reactor-powered real-time generation can do in under a few minutes. They may have no prompt-writing experience and should not need to understand models, tokens, or API keys.

## Core experience

1. Choose Play or Watch from the landing screen.
2. Reach a live generated stream with a clear loading state.
3. Shape the result through a prompt, image, movement, or voice action.
4. Leave with a memorable frame or prompt worth sharing.

## Current capabilities

- Play mode with Lingbot World 2, keyboard movement, scene editing, reference-image upload, pause/reset, and a bounded demo session.
- Hold-to-talk English transcription through Deepgram; speech defaults to a player action, while `Change world to …` updates the scene.
- Watch mode with a separate movie setup, optional reference image, Helios real-time streaming, pause/restart/back controls, and a two-minute default limit.
- API keys remain on the server; audio recordings are not stored by the app.

## Product boundaries

Not planned for the current demo product:

- Accounts, collaboration, multiplayer, or saved cloud sessions.
- Long-running or unlimited generation by default.
- A general-purpose video editor or game progression system.
- Collection of personal data beyond any future privacy-safe aggregate telemetry.

## Success signals

- Visitors reach their first generated frame without needing help.
- Visitors use at least one control after entering a mode: a preset, prompt, image, movement, or voice action.
- Visitors complete a Watch session or capture a result.
- Model, microphone, and configuration failures are understandable and recoverable.
