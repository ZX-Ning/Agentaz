# Historical Handoff: Pi SDK embedding discussion

This is a historical handoff from an earlier Pi SDK exploration. It is retained as background reference, not as the canonical Agentaz architecture document. For current implementation guidance, use `docs/plan.md`, `docs/backend.md`, `docs/frontend.md`, and `AGENTS.md`.

## Context

The user is exploring how to embed a Pi agent into a Node.js project using the Pi SDK.

Relevant documentation read in this session:

- `/home/zxning/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- `/home/zxning/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Examples inspected:
  - `/home/zxning/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/01-minimal.ts`
  - `/home/zxning/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/05-tools.ts`
  - `/home/zxning/.vite-plus/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/09-api-keys-and-oauth.ts`

No workspace files were modified.

## What was explained

### Basic SDK embedding

The user asked how to embed an agent in a Node.js project. The answer covered:

- Install package: `npm install @earendil-works/pi-coding-agent`
- Use ESM / TypeScript
- Create an `AgentSession` with `createAgentSession()`
- Use `AuthStorage`, `ModelRegistry`, and `SessionManager.inMemory()`
- Subscribe to streaming events with `session.subscribe(...)`
- Send work with `await session.prompt(...)`
- Dispose the session with `session.dispose()`

### `session.prompt(...)`

The user asked whether `session.prompt` starts the agent loop. The answer: yes.

It was explained that `session.prompt(...)`:

- Adds/sends the user message
- Calls the model
- Streams assistant output
- Executes requested tools
- Sends tool results back to the model
- Repeats until the model stops or errors
- Resolves only after the full accepted run finishes

Also explained:

- Use `session.steer(...)` or `session.followUp(...)` while streaming
- Or use `session.prompt(..., { streamingBehavior: "steer" | "followUp" })`

### Session management

The user asked how sessions are managed. The answer covered:

- `AgentSession` manages one current conversation/agent state
- `SessionManager` manages persistence/opening/continuing sessions
- `AgentSessionRuntime` manages app-level session replacement and switching

Session patterns explained:

- Temporary in-memory session: `SessionManager.inMemory()`
- Persistent session: `SessionManager.create(cwd)`
- Continue recent: `SessionManager.continueRecent(cwd)`
- Open specific file: `SessionManager.open(path)`
- For multi-session UI/product behavior, use `createAgentSessionRuntime(...)`

### `createAgentSessionRuntime(...)`

The user asked for an explanation of `createAgentSessionRuntime`. The answer covered:

- It is a higher-level runtime over `createAgentSession()`
- `createAgentSession()` creates a single session
- `createAgentSessionRuntime()` owns a replaceable `runtime.session`
- Use it for new session, switch session, resume, fork, clone, import, cwd-bound rebuilds
- It needs a `CreateAgentSessionRuntimeFactory`
- The factory generally calls:
  - `createAgentSessionServices({ cwd })`
  - `createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })`
- Important caveat: `runtime.session` changes after replacement operations, so event subscriptions must be reattached

## Historical user intent

The user likely wants to continue learning or implementing a Node.js integration using Pi SDK. They may next ask for:

- A concrete project scaffold
- How to expose the agent through an HTTP/WebSocket server
- How to persist sessions per user
- How to stream events to a frontend
- How to add custom tools
- How to restrict tool permissions for safety
- How to use runtime for session switching in an app

## Suggested skills

- No external skill is strictly needed for normal Pi SDK coding help.
- If the next task asks about Pi itself, SDK, extensions, themes, skills, or TUI, follow the project instruction to read the relevant Pi docs first, especially `docs/sdk.md` and referenced examples.
- If the next task involves creating or modifying documents such as `.docx`, use the `docx` skill.
- If the next task involves web research or current external information, use an appropriate Tavily skill.
- If the next task asks for another handoff, use the `handoff` skill again.

## Notes for next agent

- Keep responses concise and technical, preferably in Chinese since the user asked in Chinese.
- Answer questions first before proposing edits or commands.
- Do not assume the user wants workspace code changes unless they asks for implementation.
- If implementing code in this repo, follow `/home/zxning/code/Agentaz/AGENTS.md`, use pnpm from the repository root, and run `pnpm typecheck` after normal code edits.
