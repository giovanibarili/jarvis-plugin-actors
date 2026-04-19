# jarvis-plugin-actors — Functional Tests

> BDD scenarios for validating the Actor Pool plugin end-to-end.
> Execute these after any code change, plugin update, or JARVIS core upgrade.

## Feature: Actor Lifecycle

### Scenario: Dispatch a new actor with a task

```gherkin
Given the actor pool is empty
When I call actor_dispatch with name "alpha", role "generic", and task "List files in the current directory"
Then actor "alpha" should appear in the pool with status "running"
And the Actor Pool HUD panel should show "1/5"
And actor "alpha" should eventually report back with a result containing file names
And the result message should be prefixed with "[ACTOR:alpha]"
And actor "alpha" status should transition to "idle" after completion
```

### Scenario: Reuse an existing actor session

```gherkin
Given actor "alpha" exists in the pool with status "idle"
When I call actor_dispatch with name "alpha", role "generic", and task "What was the last thing I asked you?"
Then actor "alpha" should reuse its existing session (not create a new one)
And the response should reference the previous task (demonstrating memory persistence)
And actor "alpha" task count should increment
```

### Scenario: Dispatch to a busy actor is rejected

```gherkin
Given actor "alpha" exists with status "running"
When I call actor_dispatch with name "alpha", role "generic", and task "Another task"
Then the response should contain error "Actor 'alpha' is busy"
And actor "alpha" should continue its current task uninterrupted
```

### Scenario: Kill an actor

```gherkin
Given actor "alpha" exists in the pool
When I call actor_kill with name "alpha"
Then actor "alpha" should be removed from the pool
And actor_list should return an empty actors array
And the Actor Pool HUD panel should show "0/5" and "no actors"
```

### Scenario: Kill a non-existent actor

```gherkin
Given the actor pool is empty
When I call actor_kill with name "ghost"
Then the response should contain error "Actor not found: ghost"
```

### Scenario: Pool capacity limit

```gherkin
Given 5 actors exist in the pool (the maximum)
When I call actor_dispatch with name "sixth", role "generic", and task "Any task"
Then the response should contain error "Pool full (5/5)"
And no new actor session should be created
```

## Feature: Actor Roles

### Scenario: Dispatch with a built-in role

```gherkin
Given the actor pool is empty
When I call actor_dispatch with name "reader", role "researcher", and task "Read the first 3 lines of app/src/core/bus.ts"
Then actor "reader" should be created with role "researcher"
And the actor should execute read-only tools (read_file, grep, etc.)
And actor_list should show role "researcher" for actor "reader"
```

### Scenario: Dispatch with an unknown role

```gherkin
Given the actor pool is empty
When I call actor_dispatch with name "bob", role "wizard", and task "Cast a spell"
Then the response should contain error "Unknown role: wizard"
And no actor should be created
```

### Scenario: Custom roles from ~/.jarvis/roles/

```gherkin
Given a file exists at ~/.jarvis/roles/custom-role.md with valid YAML frontmatter (name, description) and a system prompt body
When JARVIS starts or the plugin reloads
Then "custom-role" should appear in the available roles list
And I should be able to dispatch an actor with role "custom-role"
```

### Scenario: All roles from ~/.jarvis/roles/ are loaded

```gherkin
Given ~/.jarvis/roles/ contains .md files with valid YAML frontmatter
When actor_list is called
Then the roles array should include every .md file from the directory
And each role should have id (filename without .md), name (from frontmatter), and description (from frontmatter)
And built-in fallback roles should NOT appear when custom files exist
```

**Validation command:**
```
actor_list() → verify roles array contains all files from ~/.jarvis/roles/
  Expected: coder, discovery, generic, researcher, reviewer, sandboxed-worker,
            skill-curator, world-map-igaram, world-map-mihawk, world-map-nami,
            world-map-vivi, world-map-zoro
```

### Scenario: Malformed role file is skipped

```gherkin
Given ~/.jarvis/roles/broken.md exists but has no YAML frontmatter (missing --- delimiters)
When JARVIS loads roles
Then "broken" should NOT appear in the available roles list
And no error should crash the plugin
And all other valid roles should still be loaded
```

### Scenario: Role system prompt is injected into actor session

```gherkin
Given a role "coder" exists with system prompt "You are a coding agent for JARVIS..."
When I dispatch actor "dev" with role "coder" and task "What is your role? Reply in one sentence."
Then the actor's response should reflect the coder role instructions
And the actor should behave according to its role constraints
```

## Feature: Bus Communication

### Scenario: Fire-and-forget message to an actor

```gherkin
Given actor "alpha" exists with status "idle"
When I call bus_publish with channel "ai.request", target "actor-alpha", and text "Hello"
Then actor "alpha" should receive and process the message
And no response should be routed back to the main session
```

### Scenario: Request-reply message to an actor

```gherkin
Given actor "alpha" exists with status "idle"
When I call bus_publish with channel "ai.request", target "actor-alpha", text "What is 2+2?", and reply_to "main"
Then actor "alpha" should process the message
And a response prefixed with "[ACTOR:alpha]" should arrive in the main session
And the response should contain the answer
```

### Scenario: Message queuing when actor is busy

```gherkin
Given actor "alpha" is currently running a task
When I send a bus_publish message to actor "alpha"
Then the message should be queued
And after the current task completes, the queued message should be processed automatically
```

### Scenario: Actor-to-actor communication

```gherkin
Given actor "a1" and actor "a2" both exist with status "idle"
When I dispatch a task to "a1": "Send the message 'ping from a1' to actor a2 using bus_publish, with reply_to set to your own session 'actor-a1'"
Then actor "a1" should call bus_publish with channel "ai.request", target "actor-a2", text "ping from a1", reply_to "actor-a1"
And actor "a2" should receive the message and process it
And actor "a2"'s response should be routed back to actor "a1" (not to main)
And actor "a1" should receive and incorporate "a2"'s response into its final result
```

### Scenario: Actor discovers who is alive in the pool

```gherkin
Given actors "a1", "a2", and "a3" exist in the pool
When I dispatch a task to "a1": "Use actor_list to find out which actors are alive and report their names and roles"
Then actor "a1" should call actor_list
And the result should include all 3 actors with their roles and statuses
And actor "a1" should report the pool state back accurately
```

## Feature: Actor Status Reporting

### Scenario: Actor reports its own status

```gherkin
Given actor "alpha" is running a task
When actor "alpha" calls actor_status with status "working" and message "Running tests"
Then the Actor Pool HUD should display "[working] Running tests" for actor "alpha"
And actor_list should include the status message
```

## Feature: HUD Panel

### Scenario: Actor Pool panel renders correctly on startup

```gherkin
Given the plugin is installed and enabled
When JARVIS starts
Then the Actor Pool panel should be visible in the HUD
And it should display "actors 0/5" with "no actors"
And a "+" button should be visible for creating actors
```

### Scenario: Panel updates in real-time via SSE

```gherkin
Given the Actor Pool panel is visible
When an actor is dispatched, completes, or is killed
Then the panel should update within 1 second to reflect the new state
And no full page refresh should be needed
```

### Scenario: Create actor from HUD

```gherkin
Given the Actor Pool panel is visible and the pool is not full
When I click the "+" button, enter a name, select a role, and click "create"
Then a new actor should be created in the pool
And the main session should receive a system message about the creation
And the actor should appear in the panel with status "idle"
```

### Scenario: Kill actor from HUD

```gherkin
Given the Actor Pool panel shows an actor "alpha"
When I click the "✕" button next to actor "alpha"
Then actor "alpha" should be killed
And the main session should receive a system message about the kill
And the panel should update to remove the actor
```

### Scenario: HUD "+" button creates actor via HTTP

```gherkin
Given the Actor Pool panel shows "0/5" with a "+" button visible
When I POST to /plugins/actors/create with body {"name": "hud-test", "role": "generic"}
Then the response should be {"ok": true}
And the main session should receive a [SYSTEM] message: 'Actor "hud-test" (generic) created by the user from the HUD'
And the message should include "DO NOT kill this actor"
And actor_list should show "hud-test" with status "idle"
And the Actor Pool panel should update to "1/5" with actor "hud-test" listed
```

### Scenario: HUD "✕" button kills actor via HTTP

```gherkin
Given actor "hud-test" exists in the pool
When I POST to /plugins/actors/hud-test/kill
Then the response should be {"ok": true}
And the main session should receive a [SYSTEM] message: 'Actor "hud-test" was manually killed from the HUD'
And actor_list should return an empty actors array
And the Actor Pool panel should update to "0/5" with "no actors"
```

### Scenario: HUD "+" button is hidden when pool is full

```gherkin
Given 5 actors exist in the pool
When the Actor Pool panel renders
Then the "+" button should NOT be visible
And POST to /plugins/actors/create should still succeed (actor-pool enforces the limit, not the renderer)
But actor-pool should reject the creation (pool full)
```

### Scenario: Actor node appears in core node graph

```gherkin
Given the core node graph is rendering
When actor "alpha" is dispatched with a task
Then the "Actors" node in the graph should show meta.active = 1
And when actor "alpha" completes and returns to idle
Then meta.active should return to 0
And the graph should reflect changes via SSE without page refresh
```

### Scenario: Core node graph reflects pool size

```gherkin
Given the core node graph is rendering
And 3 actors are alive in the pool (2 idle, 1 running)
Then the "Actors" node should display with meta: { max: 5, active: 1 }
When all 3 actors are killed
Then the "Actors" node should display with meta: { max: 5, active: 0 }
```

### Scenario: Actor node status transitions in graph

```gherkin
Given actor "alpha" exists in the pool with status "idle"
And the core node graph shows "alpha" as a child of "Actors" with status "idle"
When I dispatch a task to actor "alpha" that involves tool use
Then the graph node for "alpha" should transition through:
  1. "processing" — when the actor starts streaming a response (delta event)
  2. "waiting_tools" — when the actor calls a tool (tool_start event)
  3. "processing" — when the tool returns and the actor continues (tool_done event)
  4. "idle" — when the actor finishes (complete event)
And each state should be reflected in the graph node color:
  - "idle" → green
  - "processing" → orange
  - "waiting_tools" → purple
```

**Validation command:**
```
1. actor_dispatch(name="alpha", role="generic", task="Read the first line of app/src/core/bus.ts")
2. During execution, use jarvis_eval to inspect graph:
   const { graphRegistry } = await import('./core/graph-registry.js');
   const tree = graphRegistry.getTree();
   const alpha = tree.find(n => n.id === 'actor-alpha');
   return alpha?.status;  // should cycle: idle → processing → waiting_tools → processing → idle
3. hud_screenshot() — verify actor node color matches status
```

### Scenario: Actor appears and disappears from graph

```gherkin
Given the core node graph shows "Actors" with no children
When I dispatch actor "beta" with a task
Then a new child node "beta" should appear under "Actors" in the graph
And the "Actors" node meta should show active: 1
When actor "beta" completes and I kill it
Then the "beta" node should disappear from the graph
And the "Actors" node meta should show active: 0
```

### Scenario: HUD Actor Pool panel validates

```gherkin
Given the plugin is installed and running
Then the Actor Pool panel should render with:
  - Title bar showing "ACTOR POOL"
  - Counter showing "N/5" where N is current actor count
  - "+" button visible when pool is not full (hidden when 5/5)
  - Each actor row showing: status dot (colored), name, "role #taskCount", and "✕" kill button
  - "no actors" text when pool is empty
And the panel should be draggable and resizable
And the panel should have pin (📌), minimize, and close buttons in the title bar
```

## Feature: Actor Chat (HTTP API)

### Scenario: Send a message via HTTP

```gherkin
Given actor "alpha" exists
When I POST to /plugins/actors/alpha/send with body {"text": "Hello"}
Then the response should be {"ok": true}
And actor "alpha" should process the message
```

### Scenario: Stream actor output via SSE

```gherkin
Given actor "alpha" exists
When I connect to GET /plugins/actors/alpha/stream
Then I should receive an SSE connection
And when actor "alpha" processes a task, I should receive:
  - "user" events for incoming messages
  - "delta" events for streamed text
  - "tool_start" and "tool_done" events for tool executions
  - "done" event with the full response text
```

### Scenario: Get chat history

```gherkin
Given actor "alpha" has processed at least one task
When I GET /plugins/actors/alpha/history
Then the response should contain an array of chat entries
And each entry should have "role" ("user" or "actor") and "text"
```

### Scenario: Abort a running actor via HTTP

```gherkin
Given actor "alpha" is running a task
When I POST to /plugins/actors/alpha/abort
Then the actor's current operation should be aborted
And an "aborted" event should be emitted on the actor's SSE stream
```

## Feature: Error Handling

### Scenario: Actor crashes during task execution

```gherkin
Given actor "alpha" is running a task
When the task causes an unhandled error in the AI session
Then the error should be caught and reported back as "Crashed: <error>"
And actor "alpha" should not be left in a broken state
And subsequent tasks should still be processable
```

### Scenario: Plugin renderer fails to load

```gherkin
Given the ActorPoolRenderer.tsx has a syntax error
When the HUD requests /plugins/jarvis-plugin-actors/renderers/ActorPoolRenderer.js
Then the server should return a build error
And other HUD panels should continue to render normally (no React tree crash)
```

## Feature: Logging

### Scenario: Actor lifecycle events are logged

```gherkin
Given JARVIS is running with logging to .jarvis/logs/jarvis.log
When I dispatch actor "alpha" with role "generic" and task "Say hello"
Then the log file should contain entries for:
  - "CapabilityRegistry: executing" with tool "actor_dispatch"
  - Bus publish to channel "ai.request" with target "actor-alpha"
  - Bus publish to channel "system.event" with event "actor.dispatch.result"
And when I kill actor "alpha"
Then the log should contain:
  - "CapabilityRegistry: executing" with tool "actor_kill"
  - Bus publish to channel "system.event" with event "actor.kill"
```

**Validation command:**
```
grep -E "actor_dispatch|actor_kill|actor\.dispatch\.result|actor\.kill" .jarvis/logs/jarvis.log | tail -10
```

### Scenario: HUD state changes are logged

```gherkin
Given the HUD is running
When a piece publishes a hud.update event
Then the log should contain "HudState: added" or "HudState: updated" with the pieceId
And when a piece is removed, the log should contain "HudState: removed"
```

### Scenario: Bus messages are logged with eventId

```gherkin
Given JARVIS is running at debug log level
When any message is published on the bus
Then the log should contain "bus: publish" with:
  - channel name
  - source
  - a unique eventId (UUID)
And tool executions should log "CapabilityExecutor: executing" with session, count, and tool names
```

## Execution Checklist

Run these commands in order to validate the full lifecycle:

```
1. actor_dispatch(name="test", role="generic", task="List files in current directory")
   → Verify: result arrives, HUD shows 1/5

2. actor_dispatch(name="test", role="generic", task="What did I ask you before?")
   → Verify: actor reuses session, references previous task

3. bus_publish(channel="ai.request", target="actor-test", text="What is 2+2?", reply_to="main")
   → Verify: response "[ACTOR:test] 4" arrives in main

4. actor_list()
   → Verify: shows actor "test" with role "generic", taskCount >= 2

5. actor_kill(name="test")
   → Verify: pool empty, HUD shows 0/5

6. hud_screenshot()
   → Verify: Actor Pool panel visible, "no actors" displayed
```
