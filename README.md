# jarvis-plugin-actors

Persistent AI actor pool for JARVIS. Create named actors with roles that maintain conversation memory across tasks. Actors execute autonomously with tool access and report results back to the main session.

## Install

Ask JARVIS:

```
"Install the actors plugin from github.com/giovanibarili/jarvis-plugin-actors"
```

## How it works

The plugin provides 3 pieces that work together via the EventBus.

**ActorPoolPiece** manages the pool of actors (create, reuse, kill) and registers 4 tools: `actor_dispatch`, `actor_list`, `actor_kill`, `bus_publish`. When a task is dispatched, it publishes an `actor.dispatch` event on the bus.

**ActorRunnerPiece** consumes `actor.dispatch` events and runs tasks autonomously. It creates AI sessions via the JARVIS session factory, executes the stream+tool loop (up to 15 rounds), and publishes stream events (`core.actor-{name}.stream.*`) for real-time visibility. Results are published back via `actor.dispatch.result`.

**ActorChatPiece** registers HTTP routes on the main JARVIS server for direct actor communication: SSE streaming, message sending, and history retrieval.

## Roles

| Role | Description |
|------|-------------|
| generic | General-purpose worker |
| researcher | Read-only investigation and analysis |
| coder | Writes and edits code |
| reviewer | Read-only code review |

## Tools

- **actor_dispatch** — send a task to a named actor (creates if new, reuses if existing)
- **actor_list** — list all actors with status, role, task count
- **actor_kill** — destroy an actor and its session
- **bus_publish** — publish a message to any bus topic

## HTTP Routes (on main server)

| Route | Method | Description |
|-------|--------|-------------|
| /plugins/actors/{name}/stream | GET | SSE stream of actor messages |
| /plugins/actors/{name}/send | POST | Send message to actor |
| /plugins/actors/{name}/history | GET | Chat history |

## License

ISC
