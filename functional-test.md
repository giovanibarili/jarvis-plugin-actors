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

### Scenario: Messages to busy actor are queued via bus

```gherkin
Given actor "alpha" is currently running a task
When I send a bus_publish message to actor "alpha"
Then the message should be queued by actor-runner
And after the current task completes, the queued message should be processed automatically
```

> Note: `actor_dispatch` rejects busy actors. Bus messages (`ai.request`) are queued instead.

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

### Scenario: Role system prompt is injected into actor session

```gherkin
Given a role "coder" exists with system prompt "You are a coding agent for JARVIS..."
When I dispatch actor "dev" with role "coder" and task "What is your role? Reply in one sentence."
Then the actor's response should reflect the coder role instructions
And the actor should behave according to its role constraints
```

## Feature: Ephemeral vs Persistent Actors

### Scenario: Actors are ephemeral by default

```gherkin
Given the actor pool is empty
When I create actor "temp" from the HUD (click "+", enter name, select role, click "create")
Then actor "temp" should have persistent = false
And the 💨 icon should be shown in the pool row (not 💾)
And SessionManager.isEphemeral("actor-temp") should return true
```

### Scenario: Toggle persistence via HUD

```gherkin
Given actor "temp" exists with persistent = false
When I click the 💨 icon next to "temp" in the Actor Pool panel
Then actor "temp" should toggle to persistent = true
And the icon should change to 💾
And SessionManager.isEphemeral("actor-temp") should return false
```

**Validation command:**
```
curl -s -X POST http://localhost:50052/plugins/actors/toggle-persistent/temp
→ {"ok": true, "persistent": true}
```

### Scenario: Ephemeral actor does NOT survive restart

```gherkin
Given actor "temp" exists with persistent = false (ephemeral)
When JARVIS is restarted
Then actor "temp" should NOT appear in the pool after boot
And no file actor-temp.json should exist in .jarvis/sessions/
```

### Scenario: Persistent actor survives restart

```gherkin
Given actor "keeper" exists with persistent = true
And actor "keeper" has processed at least one task
When JARVIS is restarted
Then actor "keeper" should appear in the pool after boot
And file actor-keeper.json should exist in .jarvis/sessions/
And actor "keeper" should retain its conversation history
```

**Validation command:**
```
1. actor_dispatch(name="keeper", role="generic", task="Remember the word 'pineapple'", persistent=true)
2. Wait for completion
3. Toggle persistent if not already: curl -X POST http://localhost:50052/plugins/actors/toggle-persistent/keeper
4. jarvis_reset (restart)
5. After restart: actor_list() → "keeper" should be in the pool
6. actor_dispatch(name="keeper", role="generic", task="What word did I ask you to remember?")
7. Response should mention "pineapple"
```

### Scenario: Ephemeral kill deletes session file

```gherkin
Given actor "temp" is ephemeral and has processed tasks
And a session file actor-temp.json may exist due to auto-save
When actor "temp" is killed (via HUD ✕ or actor_kill)
Then the file .jarvis/sessions/actor-temp.json should be deleted
And the session should NOT be saved on close
```

### Scenario: Persistent kill preserves session file

```gherkin
Given actor "keeper" is persistent and has processed tasks
When actor "keeper" is killed (via HUD ✕ or actor_kill)
Then the file .jarvis/sessions/actor-keeper.json should still exist
And the session is saved before closing
```

### Scenario: Ephemeral actors cleaned on shutdown

```gherkin
Given 2 actors exist: "eph" (ephemeral) and "pers" (persistent)
Both have processed tasks
When JARVIS shuts down (SIGINT)
Then pieceManager.stopAll() runs BEFORE sessions.saveAll()
And actor-runner.stop() deletes ephemeral session files (actor-eph.json)
And sessions.saveAll() saves remaining sessions (actor-pers.json)
And after restart: only "pers" is restored
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

## Feature: HUD — Actor Pool Panel

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
Then a new actor should be created in the pool (ephemeral by default)
And the main session should receive a [SYSTEM] message about the creation
And the actor should appear in the panel with status "idle"
And the row should show: ● name, role #0, 💨 icon, ✕ button
```

**Validation command:**
```
curl -s -X POST http://localhost:50052/plugins/actors/create \
  -H "Content-Type: application/json" \
  -d '{"name": "hud-test", "role": "generic"}'
→ {"ok": true}
→ Main session receives: [SYSTEM] Actor "hud-test" (generic) created by the user from the HUD
```

### Scenario: Kill actor from HUD (✕ button)

```gherkin
Given actor "hud-test" exists in the pool
When I click the "✕" button next to actor "hud-test"
Then a POST request is sent to /plugins/actors/hud-test/kill
And actor "hud-test" should be removed from the pool
And the main session should receive a [SYSTEM] message about the kill
And the panel should update to remove the actor
And if the actor was ephemeral, its session file should be deleted
```

### Scenario: HUD "+" button is hidden when pool is full

```gherkin
Given 5 actors exist in the pool
When the Actor Pool panel renders
Then the "+" button should NOT be visible
```

### Scenario: Actor Pool panel layout

```gherkin
Given the plugin is installed and running
Then the Actor Pool panel should render with:
  - Title bar showing "ACTOR POOL"
  - Counter showing "N/5" where N is current actor count
  - "+" button visible when pool is not full (hidden when 5/5)
  - Each actor row: status dot (colored ● ), name, "role #taskCount", 💾/💨 icon, ✕ button
  - "no actors" text when pool is empty
And the panel should be draggable and resizable
And the panel should have pin (📌), minimize, and close buttons in the title bar
```

## Feature: HUD — Actor Chat Panel

### Scenario: Open actor chat by clicking actor name

```gherkin
Given actor "alpha" exists in the pool
When I click on "alpha" in the Actor Pool panel
Then a POST is sent to /plugins/actors/open-chat/alpha
And a new ephemeral HUD panel opens titled "Chat: alpha"
And the panel renders ActorChatRenderer which embeds the core ChatPanel component
And chat history is loaded from GET /plugins/actors/alpha/history
```

### Scenario: Send message in actor chat

```gherkin
Given the actor chat panel for "alpha" is open
When I type a message and press Enter
Then the ChatPanel POSTs to /plugins/actors/alpha/send
And actor-chat piece publishes the message on bus to actor-alpha
And the actor processes the message
And the response streams via SSE from /plugins/actors/alpha/stream
And delta events render in real-time in the chat panel
And tool_start/tool_done events show capability execution bars
```

### Scenario: Actor chat shows history from previous interactions

```gherkin
Given actor "alpha" has been dispatched tasks via actor_dispatch previously
When I open the actor chat panel
Then all previous user messages and actor responses should be visible
And the history is sourced from SessionManager (not a separate in-memory store)
And tool_result messages are filtered out (same as core ChatPiece)
```

### Scenario: Abort running actor from chat

```gherkin
Given actor "alpha" is running (processing a message)
And the actor chat panel is open
When I click the abort button in the chat panel
Then a POST is sent to /plugins/actors/alpha/abort
And the actor's current operation is aborted
And an "aborted" event is emitted on the SSE stream
```

### Scenario: Chat panel requires __JARVIS_COMPONENTS

```gherkin
Given the HUD exposes window.__JARVIS_COMPONENTS.ChatPanel
When ActorChatRenderer loads
Then it should reuse the core ChatPanel component (not a custom implementation)
And if __JARVIS_COMPONENTS is not available, it should show a warning message
```

## Feature: Actor Chat (HTTP API)

### Scenario: Send a message via HTTP

```gherkin
Given actor "alpha" exists
When I POST to /plugins/actors/alpha/send with body {"text": "Hello"}
Then the response should be {"ok": true}
And actor "alpha" should process the message
```

### Scenario: Send a message with images via HTTP

```gherkin
Given actor "alpha" exists with status "idle"
When I POST to /plugins/actors/alpha/send with body:
  {
    "text": "Describe this image",
    "images": [{"label": "Image #1", "base64": "<valid-png-base64>", "mediaType": "image/png"}]
  }
Then the response should be {"ok": true}
And actor "alpha" should receive the message with the image attached
And the actor's response should describe the image content
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
And the entries are sourced from SessionManager (not an in-memory duplicate)
And tool_result messages should be filtered out
```

### Scenario: Abort a running actor via HTTP

```gherkin
Given actor "alpha" is running a task
When I POST to /plugins/actors/alpha/abort
Then the actor's current operation should be aborted
And an "aborted" event should be emitted on the actor's SSE stream
```

## Feature: Session Persistence (via SessionManager)

### Scenario: Persistent actor session is saved to disk on idle

```gherkin
Given actor "alpha" is persistent and has completed a task (transitioned to "idle")
When I check the sessions directory (.jarvis/sessions/)
Then a file "actor-alpha.json" should exist
And it should contain the actor's conversation messages
And the provider and model fields should match the current configuration
```

**Validation command:**
```
1. actor_dispatch(name="alpha", role="generic", task="Say hello", persistent=true)
2. Wait for completion (status → idle)
3. bash: cat .jarvis/sessions/actor-alpha.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'messages: {d[\"messageCount\"]}, provider: {d[\"provider\"]}')"
   → Should show messageCount >= 2, provider "anthropic"
```

### Scenario: Ephemeral actor session is NOT saved to disk

```gherkin
Given actor "eph" is ephemeral (persistent = false, the default)
And actor "eph" has completed a task (transitioned to "idle")
When I check the sessions directory (.jarvis/sessions/)
Then no file "actor-eph.json" should exist
Because SessionManager skips saving when isEphemeral returns true
```

### Scenario: Abort cleans up message history properly

```gherkin
Given actor "alpha" is in "waiting_tools" state (waiting for a tool to complete)
When I POST to /plugins/actors/alpha/abort
Then cleanupAbortedTools should be called on the session (same as core JarvisCore behavior)
And the actor's message history should not contain orphaned tool_use blocks without matching tool_result
And subsequent tasks should work correctly without message format errors
```

## Feature: Node Graph Integration

### Scenario: Actor node appears in core node graph

```gherkin
Given the core node graph is rendering
When actor "alpha" is dispatched with a task
Then the "Actors" node in the graph should show meta.active = 1
And when actor "alpha" completes and returns to idle
Then meta.active should return to 0
And the graph should reflect changes via SSE without page refresh
```

### Scenario: Actor node status transitions in graph

```gherkin
Given actor "alpha" exists in the pool with status "idle"
And the core node graph shows "alpha" as a child of "Actors" with status "idle"
When I dispatch a task to actor "alpha" that involves tool use
Then the graph node for "alpha" should transition through:
  1. "processing" — when the actor starts streaming a response
  2. "waiting_tools" — when the actor calls a tool
  3. "processing" — when the tool returns and the actor continues
  4. "idle" — when the actor finishes
And each state should be reflected in the graph node color:
  - "idle" → green
  - "processing" → orange
  - "waiting_tools" → purple
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

5. curl -s http://localhost:50052/plugins/actors/test/history
   → Verify: returns array with user/actor entries

6. Open actor chat: click "test" in pool → chat panel opens → send message → streamed response

7. Toggle persistent: click 💨 → becomes 💾
   → Verify: curl -s POST http://localhost:50052/plugins/actors/toggle-persistent/test

8. jarvis_reset → restart → actor_list() → "test" should be in the pool (persistent)

9. actor_kill(name="test")
   → Verify: pool empty, HUD shows 0/5, session file preserved (was persistent)

10. Create ephemeral actor from HUD (+), kill it (✕)
    → Verify: no session file left on disk

11. hud_screenshot()
    → Verify: Actor Pool panel visible, correct state
```
