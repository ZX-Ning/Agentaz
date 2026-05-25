# Server Runtime Architecture

This document visualizes the current Agentaz server runtime structure and data flow.

## Service Structure

```mermaid
flowchart TD
  Startup["Nitro startup plugin<br/>server/plugins/startup.ts"]
  Runtime["AgentRuntime singleton<br/>agent-runtime.ts"]

  Bus["AgentEventBus<br/>agent-event-bus.ts"]
  Workspace["PiSessionWorkspace<br/>pi-session-workspace.ts"]
  Presence["ClientPresence<br/>client-presence.ts"]
  Projector["SessionProjector<br/>session-projector.ts"]
  Hub["WsAgentHub<br/>ws-agent-hub.ts"]

  Controller["PiSessionController<br/>pi-session-controller.ts"]
  PiSDK["Pi SDK<br/>services/session/extensions"]
  HTTP["HTTP routes<br/>server/api/agent/*"]
  WS["WebSocket route<br/>routes/api/agent/ws.ts"]

  Startup -->|"configureAgentRuntime()"| Runtime
  Runtime --> Bus
  Runtime --> Workspace
  Runtime --> Presence
  Runtime --> Projector
  Runtime --> Hub

  Workspace --> Controller
  Controller --> PiSDK
  Controller -->|"ServerEvent via emit()"| Bus
  Workspace -->|"state/session events"| Bus

  HTTP -->|"getAgentRuntime()"| Runtime
  WS -->|"getAgentRuntime().hub"| Hub

  Hub -->|"attach/detach"| Presence
  Hub -->|"subscribe"| Bus
  Hub -->|"state snapshots"| Projector
  Projector --> Workspace
  Projector --> Presence
```

## Startup And Singleton Initialization

```mermaid
sequenceDiagram
  participant Nitro as Nitro startup plugin
  participant Runtime as AgentRuntime module
  participant Config as Nuxt runtimeConfig
  participant Services as Runtime services

  Nitro->>Config: read piWeb config
  Nitro->>Runtime: configureAgentRuntime(options)
  Runtime->>Runtime: store runtimeOptions once

  Note over Runtime: runtime instance is still lazy

  participant Route as HTTP/WS route
  Route->>Runtime: getAgentRuntime()
  Runtime->>Services: create EventBus, Workspace, Presence, Projector, Hub
  Runtime-->>Route: runtime singleton
```

## HTTP Action Flow

```mermaid
sequenceDiagram
  participant Browser
  participant Route as HTTP route
  participant Runtime as AgentRuntime
  participant Workspace as PiSessionWorkspace
  participant Presence as ClientPresence
  participant Projector as SessionProjector
  participant Bus as AgentEventBus
  participant Hub as WsAgentHub

  Browser->>Route: POST /api/agent/sessions
  Route->>Runtime: getAgentRuntime()
  Route->>Workspace: createLoadedSession()
  Workspace->>Bus: state_changed
  Route->>Presence: focus(local-browser, sessionId)
  Route->>Presence: acquireControl(local-browser, sessionId)
  Route->>Bus: control_changed
  Route->>Projector: getState(local-browser)
  Route-->>Browser: SessionOperationResponse

  Bus->>Hub: runtime event
  Hub->>Projector: getState(clientId)
  Hub-->>Browser: WS state_snapshot
```

## Pi Session Streaming

```mermaid
sequenceDiagram
  participant Browser
  participant HTTP as HTTP messages route
  participant Workspace as PiSessionWorkspace
  participant Controller as PiSessionController
  participant PiSDK as Pi SDK Session
  participant Bus as AgentEventBus
  participant Hub as WsAgentHub

  Browser->>HTTP: POST /sessions/:id/messages
  HTTP->>Workspace: submitMessage(sessionId, request)
  Workspace->>Controller: prompt/steer/followUp()
  Controller->>PiSDK: session.prompt(...)
  PiSDK-->>Controller: message/tool/status events
  Controller->>Bus: server_event(message_block_delta etc.)
  Bus->>Hub: server_event
  Hub-->>Browser: WebSocket ServerEvent
```

## WebSocket Attach And Detach

```mermaid
flowchart LR
  Peer["Browser WS peer"]
  Hub["WsAgentHub"]
  Presence["ClientPresence"]
  Projector["SessionProjector"]
  Workspace["PiSessionWorkspace<br/>loaded sessions"]

  Peer -->|"open"| Hub
  Hub -->|"attachClient(clientId)"| Presence
  Hub -->|"hello + state_snapshot"| Peer
  Hub -->|"project state"| Projector
  Projector --> Presence
  Projector --> Workspace

  Peer -->|"close"| Hub
  Hub -->|"detachClient(clientId)"| Presence
  Presence -->|"release control leases"| Presence

  Workspace -. "not closed by WS detach" .-> Workspace
```

## Session Removed Coordination

```mermaid
sequenceDiagram
  participant Workspace as PiSessionWorkspace
  participant Bus as AgentEventBus
  participant Runtime as AgentRuntime coordinator
  participant Presence as ClientPresence
  participant Hub as WsAgentHub

  Workspace->>Bus: session_removed(sessionId, fallbackSessionId)
  Bus->>Runtime: session_removed
  Runtime->>Presence: removeSession(sessionId, fallback)
  Runtime->>Bus: state_changed

  Bus->>Hub: session_removed
  Hub-->>Hub: ignore

  Bus->>Hub: state_changed
  Hub-->>Hub: broadcast state_snapshot
```

## Responsibility Summary

```txt
HTTP routes:
  - get the runtime
  - call workspace/presence/projector
  - do not manage WebSocket peers

WsAgentHub:
  - owns peers, heartbeat, and event forwarding
  - does not create or close Pi sessions

PiSessionWorkspace:
  - owns Pi SDK services and loaded sessions
  - does not know client ids or peers

ClientPresence:
  - owns client focus and control leases
  - does not know Pi SDK controllers

SessionProjector:
  - projects workspace + presence into protocol DTOs
```
