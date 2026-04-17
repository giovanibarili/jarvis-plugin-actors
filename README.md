# jarvis-plugin-actors

Persistent AI actor pool for JARVIS. Create named actors with roles that maintain conversation memory across tasks. Actors execute autonomously with tool access and report results back to the main session.

## Install

Ask JARVIS:

```
"Install the actors plugin from github.com/giovanibarili/jarvis-plugin-actors"
```

## How it works

The plugin provides 3 pieces that communicate via the typed EventBus channels.

**ActorPoolPiece** manages the pool of actors (create, reuse, kill) and registers lifecycle tools. When a task is dispatched, it publishes an `ai.request` message with `target: "actor-{name}"`. When the actor finishes, the result appears in the main chat with the actor's name as label.

**ActorRunnerPiece** listens for `ai.request` messages targeting actors. It creates AI sessions via the JARVIS session factory, executes the stream+tool loop, and publishes `ai.stream` events for real-time visibility. Each capability call is enriched with `__sessionId` so per-session features (like skills) work correctly. Results are reported back via `system.event`.

**ActorChatPiece** registers HTTP routes on the main JARVIS server for direct actor communication. It listens to `ai.request` and `ai.stream` on the bus to capture conversation history and feed SSE clients.

## Communication

The AI manages actor lifecycle via tools and communicates with actors via the EventBus:

```
bus_publish(channel="ai.request", target="actor-alice", text="que dia é hoje?")
```

Actor results appear in the main chat with the actor's name as label (e.g. ALICE in purple).

## Roles

| Role | Description |
|------|-------------|
| generic | General-purpose worker |
| researcher | Read-only investigation and analysis |
| coder | Writes and edits code |
| reviewer | Read-only code review |
| discovery | Read-only deep research — traces flows, audits dependencies |

## Tools

Lifecycle management:

- **actor_dispatch** — create a new actor and send its first task
- **actor_list** — list all actors with status, role, task count
- **actor_kill** — destroy an actor and its session

Communication:

- **bus_publish** — send messages to actors via the EventBus (channel, target, text)

## HTTP Routes (on main server, port 50052)

| Route | Method | Description |
|-------|--------|-------------|
| /plugins/actors/{name}/stream | GET | SSE stream of actor messages |
| /plugins/actors/{name}/send | POST | Send direct message to actor |
| /plugins/actors/{name}/history | GET | Chat history |

## License

ISC
