# Changelog

All notable changes to `jarvis-plugin-actors` will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: this plugin previously declared the `2.x` line as its public version. Starting with this release we adopt the `0.x` series to better reflect the experimental status and to align with `jarvis-app`'s own pre-1.0 versioning policy. There is no functional regression — the codebase is the same one that shipped as `2.1.0`, plus the changes documented below.

## [0.2.1] - 2026-04-27

### Restored

- **`broadcastPromptDispatched(name, items)`** in `actor-runner.ts`. Pairs with `jarvis-app` ≥ 0.2.6, where `ChatPiece` is now plugin-agnostic and no longer mirrors `type:"user"` for any session. The session OWNER (this plugin, for `actor-*`) is the single authority that emits `prompt_dispatched` so the chat panel renders the user entry at the moment the prompt is actually sent to the model. The helper is invoked in three places:
  - **Idle path** (`ai.request` arrives, actor is idle) — emits before kicking off `runTask`.
  - **`handleDispatch`** (programmatic `actor_dispatch` capability call) — emits before kicking off `runTask`.
  - **`drainQueue`** (a queued message becomes the next one to send) — emits to migrate the queued card into a timeline entry, and refreshes `pending_queue`.

### Removed

- **No more `[SYSTEM] <reminder>...</reminder>` injections into the main session** when an actor is created or killed from the HUD. Previously, both `handleCreateRequest` and the `/plugins/actors/<name>/kill` route published an `ai.request` to `main` with a reminder tag describing the lifecycle event. That polluted the main chat with system noise on every manual interaction with the actor pool. The actor panel itself (appearing/disappearing) is the visible feedback the user needs — main no longer gets a synthetic prompt for it.

### Compatibility

- Requires `jarvis-app` (`@jarvis/core`) ≥ 0.2.1, but the chat-timeline contract is fully aligned with `jarvis-app` ≥ 0.2.6.
- On older `jarvis-app` versions (≤ 0.2.5) where `ChatPiece` still mirrored `type:"user"` for non-core sessions, this plugin will emit `prompt_dispatched` AND `ChatPiece` will mirror — causing the same duplication the refactor was meant to fix. Upgrade `jarvis-app` together with this plugin.

## [2.1.0] - earlier

(Historical line — see git log for details. The `2.x` versioning has been retired in favour of `0.x` for this plugin.)
