/** Current wire protocol version used by the browser and backend handshake. */
export const PROTOCOL_VERSION = 4;

/** Supported Pi thinking levels exposed through the web UI. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/** Base64-encoded image attachment reserved for future multimodal prompts. */
export type ImagePayload = {
  mediaType: string;
  data: string;
};

/** Normalized render block used by the web chat transcript. */
export type UiBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "thinking"; text: string; collapsed?: boolean }
  | {
      id: string;
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      status: "pending" | "running" | "completed" | "error" | "blocked";
    }
  | {
      id: string;
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

/** Normalized chat message independent of Pi SDK's internal message representation. */
export type UiMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  blocks: UiBlock[];
  createdAt?: number;
};

/** Summary row for the current working directory's persisted Pi sessions. */
export type UiSessionSummary = {
  file: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  firstMessage?: string;
};

/** Runtime state for a Pi session currently loaded in the server process. */
export type UiLoadedSession = UiSessionSummary & {
  sessionId: string;
  sessionFile?: string;
  isWorking: boolean;
  isStreaming: boolean;
  pendingMessageCount: number;
  pendingApprovalCount: number;
  controlOwnerClientId?: string;
  controlledByCurrentClient?: boolean;
};

/** Model metadata needed by the browser model picker. */
export type UiModel = {
  provider: string;
  id: string;
  name?: string;
  availableThinkingLevels?: ThinkingLevel[];
};

/** Shared capability flags exposed by the local agent backend. */
export type AgentCapabilities = {
  steer: true;
  followUp: true;
  clearQueue: true;
  permissions: true;
  modelSelect: true;
  thinkingSelect: true;
  images: false;
  fileTree: false;
  diffViewer: false;
};

/** Initial server-to-client handshake that declares protocol version and backend capabilities. */
export type ServerHello = {
  type: "hello";
  protocolVersion: 4;
  cwd: string;
  clientId: string;
  state: AgentStateResponse;
};

/** Standard error event used for recoverable and fatal backend failures. */
export type ServerErrorEvent = {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
};

/** All backend events that may be emitted over the agent WebSocket connection. */
export type ServerEvent =
  | ServerHello
  | {
      type: "state_snapshot";
      state: AgentStateResponse;
    }
  | {
      type: "control_changed";
      sessionId: string;
      controlOwnerClientId?: string;
    }
  | { type: "message_upsert"; sessionId: string; message: UiMessage }
  | {
      type: "message_block_upsert";
      sessionId: string;
      messageId: string;
      block: UiBlock;
    }
  | {
      type: "message_block_delta";
      sessionId: string;
      messageId: string;
      blockId: string;
      blockType: "text" | "thinking";
      delta: string;
    }
  | {
      type: "permission_decision";
      sessionId?: string;
      surface: string;
      value: string;
      result: "allow" | "deny";
      resolution: string;
      matchedPattern?: string | null;
    }
  | {
      type: "queue_update";
      sessionId: string;
      steering: string[];
      followUp: string[];
    }
  | {
      type: "ui_select_request";
      sessionId: string;
      requestId: string;
      title: string;
      options: string[];
      timeoutMs: number;
    }
  | {
      type: "ui_input_request";
      sessionId: string;
      requestId: string;
      title: string;
      placeholder?: string;
      timeoutMs: number;
    }
  | {
      type: "ui_confirm_request";
      sessionId: string;
      requestId: string;
      title: string;
      message: string;
      timeoutMs: number;
    }
  | {
      type: "ui_notify";
      sessionId?: string;
      message: string;
      level?: "info" | "warning" | "error";
    }
  | {
      type: "status";
      sessionId?: string;
      isStreaming: boolean;
      pendingMessageCount: number;
      pendingApprovalCount?: number;
    }
  | ServerErrorEvent;

/** Full backend state snapshot returned by HTTP. */
export type AgentStateResponse = {
  protocolVersion: 4;
  cwd: string;
  activeSessionId?: string;
  loadedSessions: UiLoadedSession[];
  persistedSessions: UiSessionSummary[];
  capabilities: AgentCapabilities;
};

/** HTTP response carrying normalized history for one loaded session. */
export type SessionHistoryResponse = {
  sessionId: string;
  messages: UiMessage[];
};

/** HTTP request used to create a fresh session or open an existing persisted session. */
export type SessionCreateRequest = {
  sessionFile?: string;
};

/** HTTP response used by session lifecycle operations. */
export type SessionOperationResponse = AgentStateResponse & {
  sessionId?: string;
  sessionFile?: string;
};

/** HTTP response carrying model and thinking state for one session. */
export type ModelStateResponse = {
  sessionId: string;
  models: UiModel[];
  current?: UiModel;
  thinkingLevel?: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
  pendingModel?: UiModel;
  pendingThinkingLevel?: ThinkingLevel;
};

/** HTTP request used to submit prompts, steering, or queued follow-up text. */
export type MessageSubmitRequest = {
  mode: "prompt" | "steer" | "follow_up";
  text: string;
  images?: ImagePayload[];
};

/** HTTP response returned after a message has been accepted for processing. */
export type MessageSubmitResponse = {
  accepted: true;
  sessionId: string;
};

/** HTTP request used to submit a model selection. */
export type ModelSetRequest = {
  provider: string;
  id: string;
};

/** HTTP request used to submit a thinking level selection. */
export type ThinkingSetRequest = {
  level: ThinkingLevel;
};

/** HTTP request used to answer a browser-backed extension UI prompt. */
export type UiRequestResponseRequest =
  | { selected?: string }
  | { value?: string }
  | { confirmed: boolean };

/** Runtime UI representation of a session in the sidebar list. */
export type SessionListItem = {
  id: string;
  file: string | null;
  sessionId: string | null;
  isDraft: boolean;
  isLoaded: boolean;
  isActive: boolean;
  isWorking: boolean;
  isStreaming: boolean;
  pendingApprovalCount: number;
  title: string;
  updatedAt?: number;
};
