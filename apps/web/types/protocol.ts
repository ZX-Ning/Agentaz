/**
 * Current wire protocol version used by the browser and backend handshake.
 *
 * Incremented when backward-incompatible changes are made to the SSE
 * event shapes or HTTP DTOs. The frontend should refuse to operate if the
 * server's protocol version doesn't match its expected version.
 */
export const PROTOCOL_VERSION = 7;

/**
 * Supported Pi thinking levels exposed through the web UI.
 *
 * These control how much of the model's internal reasoning ("thinking")
 * is shown to the user. Higher levels show more reasoning trace.
 *   - off:     No thinking shown (default for non-reasoning models).
 *   - minimal: Brief thinking summary.
 *   - low:     Abbreviated reasoning.
 *   - medium:  Moderate reasoning detail.
 *   - high:    Detailed reasoning.
 *   - xhigh:   Maximum reasoning trace (requires model support).
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/** Base64-encoded image attachment reserved for future multimodal prompts. */
export type ImagePayload = {
  /** MIME type of the image (e.g. "image/png", "image/jpeg"). */
  mediaType: string;
  /** Base64-encoded image data (without the data: URI prefix). */
  data: string;
};

/**
 * Normalized render block used by the web chat transcript.
 *
 * Each message in the chat UI is composed of an ordered array of blocks.
 * Blocks are identified by stable ids that survive re-renders and streaming
 * updates. The four block types cover all Pi SDK content types:
 *   - text:        Markdown/text content from the agent.
 *   - thinking:    Model reasoning trace (collapsible).
 *   - tool_call:   Tool invocation with input and status.
 *   - tool_result: Tool execution output (possibly truncated).
 */
export type UiBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "thinking"; text: string; collapsed?: boolean }
  | {
      id: string;
      type: "tool_call";
      /** Unique identifier for this tool execution. */
      toolCallId: string;
      /** Display name of the tool (e.g. "read", "bash", "edit"). */
      toolName: string;
      /** Tool input arguments (provider-specific shape). */
      input: unknown;
      /** Execution status in the lifecycle: pending → running → completed/error. */
      status: "pending" | "running" | "completed" | "error" | "blocked";
    }
  | {
      id: string;
      type: "tool_result";
      /** Matches the toolCallId of the corresponding tool_call block. */
      toolCallId: string;
      /** Summarized tool output (truncated to 500 chars). */
      content: string;
      /** Whether the tool execution resulted in an error. */
      isError?: boolean;
    };

/**
 * Normalized chat message independent of Pi SDK's internal message representation.
 *
 * Messages are the top-level unit of the chat transcript. Each message has a role
 * and an ordered array of blocks. The `createdAt` timestamp is a Unix epoch in
 * milliseconds (may be absent for historical messages from older session files).
 */
export type UiMessage = {
  /** Stable identifier for this message within the transcript. */
  id: string;
  /** Current-branch Pi session entry id, present for persisted history messages. */
  entryId?: string;
  /** Previous current-branch Pi entry id used to rewind before this message. */
  rewindEntryId?: string;
  /** Speaker role: user, assistant, tool (result), or system. */
  role: "user" | "assistant" | "tool" | "system";
  /** Ordered content blocks composing this message. */
  blocks: UiBlock[];
  /** Unix epoch milliseconds when this message was created. */
  createdAt?: number;
};

/**
 * Summary row for the current working directory's persisted Pi sessions.
 *
 * Used in the sidebar session list to show sessions saved on disk that the
 * user can open. Each summary includes metadata extracted from the session
 * file header (name, timestamps, first user message for preview).
 */
export type UiSessionSummary = {
  /** Absolute path to the session file on disk. */
  file: string;
  /** Pi session identifier (may differ from file path). */
  sessionId?: string;
  /** User-assigned or auto-generated session name. */
  name?: string;
  /** Creation timestamp (Unix epoch ms). */
  createdAt?: number;
  /** Last modification timestamp (Unix epoch ms). */
  updatedAt?: number;
  /** First user message text for preview display. */
  firstMessage?: string;
};

/**
 * Browser-backed extension UI prompt awaiting a user response.
 *
 * These prompts are emitted as realtime SSE events when they are created
 * and are also included in loaded-session snapshots so a browser can recover
 * the clickable approval UI after reconnecting or refreshing while a prompt is
 * still pending.
 */
export type PendingUiRequest =
  | {
      /** Extension is requesting a single-choice selection from the user. */
      type: "ui_select_request";
      sessionId: string;
      /** Opaque id to include in the POST response. */
      requestId: string;
      /** Prompt title displayed to the user. */
      title: string;
      /** Available options for selection. */
      options: string[];
      /** Timeout in milliseconds before auto-resolving. */
      timeoutMs: number;
    }
  | {
      /** Extension is requesting text input from the user. */
      type: "ui_input_request";
      sessionId: string;
      requestId: string;
      title: string;
      /** Optional placeholder text for the input field. */
      placeholder?: string;
      timeoutMs: number;
    }
  | {
      /** Extension is requesting a yes/no confirmation from the user. */
      type: "ui_confirm_request";
      sessionId: string;
      requestId: string;
      title: string;
      /** Detailed message explaining what is being confirmed. */
      message: string;
      timeoutMs: number;
    };

/**
 * Runtime state for a Pi session currently loaded in the server process.
 *
 * Extends UiSessionSummary with live runtime fields that change as the
 * agent works. Loaded sessions are shown at the top of the sidebar with
 * status indicators for working, streaming, and pending counts.
 */
export type UiLoadedSession = Omit<UiSessionSummary, "sessionId"> & {
  /** Stable Pi session identifier used for protocol routing. */
  sessionId: string;
  /** The session file path (null for ephemeral sessions). */
  sessionFile?: string;
  /** Whether the session is busy (initializing, streaming, or has pending prompts). */
  isWorking: boolean;
  /** Whether the Pi agent is currently streaming response text. */
  isStreaming: boolean;
  /** Number of queued steer/follow-up messages. */
  pendingMessageCount: number;
  /** Number of browser-backed extension UI prompts awaiting user response. */
  pendingApprovalCount: number;
  /** Full prompt details needed to render clickable browser approval controls. */
  pendingUiRequests: PendingUiRequest[];
  /** Text projections of extension-owned widgets. */
  extensionWidgets: UiExtensionWidget[];
  /** Client id that currently holds the session control lease (if any). */
  controlOwnerClientId?: string;
  /** Whether the session control lease is held by the requesting client. */
  controlledByCurrentClient?: boolean;
};

/**
 * Text projection of an extension-owned widget rendered in the browser.
 * Extensions can render custom TUI widgets; these are projected as plain
 * text lines with a placement hint (above or below the chat editor).
 */
export type UiExtensionWidget = {
  /** Widget identifier for deduplication and updates. */
  key: string;
  /** Where to render the widget relative to the chat editor. */
  placement: "aboveEditor" | "belowEditor";
  /** Text lines rendered by the widget (pre-formatted for display). */
  lines: string[];
};

/**
 * Model metadata needed by the browser model picker.
 *
 * Each model includes its provider and id (used for the set-model HTTP
 * endpoint) plus display metadata and available thinking levels.
 */
export type UiModel = {
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model identifier within the provider (e.g. "claude-sonnet-4-20250514"). */
  id: string;
  /** Human-readable model name for display. */
  name?: string;
  /** Thinking levels supported by this model (empty for non-reasoning models). */
  availableThinkingLevels?: ThinkingLevel[];
};

/**
 * Shared capability flags exposed by the local agent backend.
 *
 * These are declared once at startup and sent in every state snapshot.
 * The frontend uses them to show/hide UI elements for features that may
 * not be supported by the current backend version.
 */
export type AgentCapabilities = {
  /** Whether steer messages (redirecting streaming output) are supported. */
  steer: true;
  /** Whether follow-up messages (queued after current turn) are supported. */
  followUp: true;
  /** Whether clearing the steer/follow-up queue is supported. */
  clearQueue: true;
  /** Whether the permission-system integration is active. */
  permissions: true;
  /** Whether in-session model selection is supported. */
  modelSelect: true;
  /** Whether in-session thinking level selection is supported. */
  thinkingSelect: true;
  /** Whether loaded sessions can be forked into a new session. */
  sessionFork: true;
  /** Whether loaded sessions can be reverted to an earlier entry. */
  sessionRevert: true;
  /** Whether image attachments in prompts are supported. */
  images: false;
  /** Whether a file tree browser is implemented. */
  fileTree: false;
  /** Whether a side-by-side diff viewer is implemented. */
  diffViewer: false;
};

// ──────────────────────────────────────────────────────────────────────────
// SSE events (server → client)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Initial server-to-client handshake that declares protocol version and
 * backend capabilities. Sent immediately after SSE connection is
 * established, before any other events.
 */
export type ServerHello = {
  type: "hello";
  /** Must match the client's expected protocol version. */
  protocolVersion: 7;
  /** Working directory shared by all sessions. */
  cwd: string;
  /** Unique client id assigned by the server for this connection. */
  clientId: string;
  /** Full initial state snapshot for immediate rendering. */
  state: AgentStateResponse;
};

/**
 * Standard error event used for recoverable and fatal backend failures.
 * The `recoverable` flag tells the frontend whether to show a retry UI
 * (true) or a fatal error message (false).
 */
export type ServerErrorEvent = {
  type: "error";
  /** Machine-readable error code (e.g. "session_not_found"). */
  code: string;
  /** Human-readable error message for display. */
  message: string;
  /** Whether the user can retry the operation. */
  recoverable: boolean;
};

/**
 * All backend events that may be emitted over the agent SSE connection.
 *
 * Events are categorized by purpose:
 *   - Connection: hello, error
 *   - State sync: state_snapshot, control_changed, status
 *   - Transcript: message_upsert, message_block_upsert, message_block_delta
 *   - Permissions: permission_decision
 *   - Queue: queue_update
 *   - Extension UI: ui_select_request, ui_input_request, ui_confirm_request,
 *     ui_notify, extension_widget_update
 */
export type ServerEvent =
  | ServerHello
  | {
      /** Full state snapshot pushed periodically (15s heartbeat) and on state change. */
      type: "state_snapshot";
      state: AgentStateResponse;
    }
  | {
      /** Session control lease changed ownership. */
      type: "control_changed";
      sessionId: string;
      /** Client id that now owns the lease, or undefined if released. */
      controlOwnerClientId?: string;
    }
  | {
      /** A message was created or updated in the transcript. */
      type: "message_upsert";
      sessionId: string;
      message: UiMessage;
    }
  | {
      /** A block within a message was created or updated. */
      type: "message_block_upsert";
      sessionId: string;
      messageId: string;
      block: UiBlock;
    }
  | {
      /** A streaming text/thinking/tool_result delta was appended to a block. */
      type: "message_block_delta";
      sessionId: string;
      messageId: string;
      blockId: string;
      blockType: "text" | "thinking" | "tool_result";
      /** The new text to append to the block. */
      delta: string;
    }
  | {
      /** A permission decision was made (log event, not interactive). */
      type: "permission_decision";
      sessionId?: string;
      /** The tool or surface requesting permission. */
      surface: string;
      /** The value being checked. */
      value: string;
      /** The decision: allow or deny. */
      result: "allow" | "deny";
      /** How the decision was reached (e.g. "default", "user"). */
      resolution: string;
      /** The permission pattern that matched, if any. */
      matchedPattern?: string | null;
    }
  | {
      /** The steer/follow-up queue contents changed. */
      type: "queue_update";
      sessionId: string;
      /** Pending steer messages (redirects to streaming output). */
      steering: string[];
      /** Pending follow-up messages (queued for next turn). */
      followUp: string[];
    }
  | PendingUiRequest
  | {
      /** Extension notification/toast for display in the browser. */
      type: "ui_notify";
      sessionId?: string;
      message: string;
      /** Severity level for styling. */
      level?: "info" | "warning" | "error";
    }
  | {
      /** Extension widget content was updated. */
      type: "extension_widget_update";
      sessionId: string;
      /** Widget identifier for deduplication. */
      key: string;
      /** Where to render the widget (default: aboveEditor). */
      placement?: UiExtensionWidget["placement"];
      /** Updated text lines, or undefined to remove the widget. */
      lines?: string[];
    }
  | {
      /** Lightweight session status update (streaming state, pending counts). */
      type: "status";
      sessionId?: string;
      isStreaming: boolean;
      pendingMessageCount: number;
      pendingApprovalCount?: number;
    }
  | ServerErrorEvent;

// ──────────────────────────────────────────────────────────────────────────
// HTTP DTOs (request/response types for REST endpoints)
// ──────────────────────────────────────────────────────────────────────────

/**
 * HTTP request used to authenticate the single local admin user.
 * Sent to POST /api/auth/login.
 */
export type AuthLoginRequest = {
  /** Plaintext password entered in the browser login form. */
  password: string;
};

/**
 * HTTP response returned after a successful login.
 * The encrypted session itself is stored in an HTTP-only cookie.
 */
export type AuthLoginResponse = {
  ok: true;
  user: {
    id: "admin";
  };
  loggedInAt: number;
};

/**
 * Full backend state snapshot returned by GET /api/agent/state.
 *
 * This is the primary synchronization payload. It includes everything the
 * frontend needs to render the full UI: loaded sessions with runtime status,
 * persisted session summaries for the sidebar, the active session for the
 * requesting client, the working directory, and capability flags.
 */
export type AgentStateResponse = {
  protocolVersion: 7;
  /** Working directory shared by all sessions. */
  cwd: string;
  /** The session currently focused by the requesting client. */
  activeSessionId?: string;
  /** All process-resident Pi sessions with live runtime status. */
  loadedSessions: UiLoadedSession[];
  /** All saved sessions in the working directory. */
  persistedSessions: UiSessionSummary[];
  /** Declared backend feature flags. */
  capabilities: AgentCapabilities;
};

/**
 * HTTP response carrying normalized history for one loaded session.
 * Returned by GET /api/agent/sessions/:sessionId/history.
 */
export type SessionHistoryResponse = {
  sessionId: string;
  /** Normalized chat messages in display order. */
  messages: UiMessage[];
};

/**
 * Browser-facing summary of one selectable session entry.
 * Returned by GET /api/agent/sessions/:sessionId/entries for the current
 * root-to-leaf branch only.
 */
export type SessionEntryInfo = {
  /** Pi SDK session entry id. */
  id: string;
  /** Pi SDK entry type, currently "message" for selectable entries. */
  type: string;
  /** Message role for message entries. */
  role?: "user" | "assistant";
  /** Short plain-text preview for picker display. */
  summary: string;
  /** Entry timestamp as ISO 8601 text. */
  timestamp: string;
  /** Position within the returned current-branch entry list. */
  index: number;
};

/**
 * HTTP response carrying selectable fork/revert entries for a loaded session.
 * Returned by GET /api/agent/sessions/:sessionId/entries.
 */
export type SessionEntriesResponse = {
  sessionId: string;
  entries: SessionEntryInfo[];
};

/**
 * HTTP request used to create a fresh session or open an existing persisted session.
 * Sent to POST /api/agent/sessions.
 */
export type SessionCreateRequest = {
  /** Absolute path to an existing session file, or omit to create a new session. */
  sessionFile?: string;
};

/**
 * HTTP request used to rename a persisted session.
 * Sent to PATCH /api/agent/sessions/metadata.
 */
export type SessionRenameRequest = {
  /** Absolute path to an existing, non-deleted session file in the configured cwd. */
  sessionFile: string;
  /** New user-facing session name. */
  name: string;
};

/**
 * HTTP request used to soft-delete a persisted session.
 * Sent to POST /api/agent/sessions/delete.
 */
export type SessionDeleteRequest = {
  /** Absolute path to an existing, non-deleted session file in the configured cwd. */
  sessionFile: string;
};

/**
 * HTTP request used to fork a loaded persisted session.
 * Sent to POST /api/agent/sessions/:sessionId/fork.
 */
export type SessionForkRequest = {
  /** Optional current-branch entry id to fork at; omitted means copy the full file. */
  entryId?: string;
  /** Optional display name to append to the forked session. */
  name?: string;
};

/**
 * HTTP request used to revert a loaded persisted session in place.
 * Sent to POST /api/agent/sessions/:sessionId/revert.
 */
export type SessionRevertRequest = {
  /** Current-branch entry id that becomes the restored conversation leaf. */
  entryId: string;
};

/**
 * HTTP response returned by session lifecycle operations (create, open, focus).
 * Extends the full state snapshot with the new/altered session's identity.
 */
export type SessionOperationResponse = AgentStateResponse & {
  sessionId?: string;
  sessionFile?: string;
};

/**
 * HTTP response carrying model and thinking state for one session.
 * Returned by GET /api/agent/models, GET /api/agent/sessions/:sessionId/models,
 * PUT /api/agent/sessions/:sessionId/model, and PUT .../thinking.
 */
export type ModelStateResponse = {
  sessionId: string;
  /** All available models for the picker dropdown. */
  models: UiModel[];
  /** Currently active model (or restored from disk). */
  current?: UiModel;
  /** Current thinking level. */
  thinkingLevel?: ThinkingLevel;
  /** Thinking levels supported by the current model. */
  availableThinkingLevels?: ThinkingLevel[];
  /** Model change queued while session is busy (shown as "pending"). */
  pendingModel?: UiModel;
  /** Thinking level change queued while session is busy. */
  pendingThinkingLevel?: ThinkingLevel;
};

/**
 * HTTP request used to submit prompts, steering, or queued follow-up text.
 * Sent to POST /api/agent/sessions/:sessionId/messages.
 */
export type MessageSubmitRequest = {
  /** Message dispatch mode. */
  mode: "prompt" | "steer" | "follow_up";
  /** Message text content. */
  text: string;
  /** Optional image attachments (reserved for future use). */
  images?: ImagePayload[];
};

/**
 * HTTP response returned after a message has been accepted for processing.
 * Note: acceptance does not mean completion — the agent runs asynchronously.
 */
export type MessageSubmitResponse = {
  /** Always true once the message is accepted. */
  accepted: true;
  /** Echo of the session id from the route param. */
  sessionId: string;
};

/**
 * HTTP request used to submit a model selection.
 * Sent to PUT /api/agent/sessions/:sessionId/model.
 */
export type ModelSetRequest = {
  /** Provider identifier (e.g. "anthropic"). */
  provider: string;
  /** Model identifier within the provider. */
  id: string;
};

/**
 * HTTP request used to submit a thinking level selection.
 * Sent to PUT /api/agent/sessions/:sessionId/thinking.
 */
export type ThinkingSetRequest = {
  /** One of the supported thinking levels. */
  level: ThinkingLevel;
};

/**
 * HTTP request used to answer a browser-backed extension UI prompt.
 * Sent to POST /api/agent/sessions/:sessionId/ui-requests/:requestId/response.
 *
 * This is a discriminated union — the backend dispatches to the correct
 * resolution method based on the explicit kind field:
 *   - { kind: "select", selected }   → resolveSelect
 *   - { kind: "input", value }       → resolveInput
 *   - { kind: "confirm", confirmed } → resolveConfirm
 */
export type UiRequestResponseRequest =
  | { kind: "select"; selected?: string }
  | { kind: "input"; value?: string }
  | { kind: "confirm"; confirmed: boolean };
