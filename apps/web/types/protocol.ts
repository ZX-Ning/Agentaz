/** Current wire protocol version used by the browser and backend handshake. */
export const PROTOCOL_VERSION = 1

/** Supported Pi thinking levels exposed through the web UI. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Base64-encoded image attachment reserved for future multimodal prompts. */
export type ImagePayload = {
  mediaType: string
  data: string
}

/** Normalized render block used by the web chat transcript. */
export type UiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; collapsed?: boolean }
  | {
      type: 'tool_call'
      toolCallId: string
      toolName: string
      input: unknown
      status: 'pending' | 'running' | 'completed' | 'error' | 'blocked'
    }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }

/** Normalized chat message independent of Pi SDK's internal message representation. */
export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: UiBlock[]
  createdAt?: number
}

/** Summary row for the current working directory's persisted Pi sessions. */
export type UiSessionSummary = {
  file: string
  name?: string
  createdAt?: number
  updatedAt?: number
  firstMessage?: string
}

/** Model metadata needed by the browser model picker. */
export type UiModel = {
  provider: string
  id: string
  name?: string
}

/** Initial server-to-client handshake that declares protocol version and backend capabilities. */
export type ServerHello = {
  type: 'hello'
  protocolVersion: 1
  cwd: string
  sessionId: string
  sessionFile?: string
  capabilities: {
    steer: true
    followUp: true
    clearQueue: true
    permissions: true
    modelSelect: true
    thinkingSelect: true
    images: false
    fileTree: false
    diffViewer: false
  }
}

/** Standard error event used for recoverable and fatal backend failures. */
export type ServerErrorEvent = {
  type: 'error'
  code: string
  message: string
  recoverable: boolean
}

/** All backend events that may be emitted over the agent WebSocket connection. */
export type ServerEvent =
  | ServerHello
  | { type: 'history'; messages: UiMessage[] }
  | { type: 'message_delta'; messageId: string; blockType: 'text' | 'thinking'; delta: string }
  | { type: 'message_upsert'; message: UiMessage }
  | { type: 'tool_start'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_update'; toolCallId: string; partial: unknown }
  | { type: 'tool_end'; toolCallId: string; isError: boolean; summary?: string }
  | { type: 'permission_decision'; surface: string; value: string; result: 'allow' | 'deny'; resolution: string; matchedPattern?: string | null }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'session_list_result'; sessions: UiSessionSummary[] }
  | { type: 'session_changed'; sessionId: string; sessionFile?: string; history: UiMessage[] }
  | { type: 'model_list_result'; models: UiModel[]; current?: UiModel; thinkingLevel?: ThinkingLevel; availableThinkingLevels?: ThinkingLevel[] }
  | { type: 'model_changed'; model: UiModel; pending?: boolean; thinkingLevel?: ThinkingLevel; availableThinkingLevels?: ThinkingLevel[] }
  | { type: 'thinking_changed'; level: ThinkingLevel; pending?: boolean }
  | { type: 'ui_select_request'; requestId: string; title: string; options: string[]; timeoutMs: number }
  | { type: 'ui_input_request'; requestId: string; title: string; placeholder?: string; timeoutMs: number }
  | { type: 'ui_confirm_request'; requestId: string; title: string; message: string; timeoutMs: number }
  | { type: 'ui_notify'; message: string; level?: 'info' | 'warning' | 'error' }
  | { type: 'status'; isStreaming: boolean; pendingMessageCount: number }
  | ServerErrorEvent

/** All browser commands accepted by the agent WebSocket connection. */
export type ClientCommand =
  | { type: 'prompt'; text: string; images?: ImagePayload[] }
  | { type: 'steer'; text: string; images?: ImagePayload[] }
  | { type: 'follow_up'; text: string; images?: ImagePayload[] }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'session_new' }
  | { type: 'session_list' }
  | { type: 'session_open'; sessionFile: string; abortCurrent?: boolean }
  | { type: 'model_list' }
  | { type: 'model_set'; provider: string; id: string }
  | { type: 'thinking_set'; level: ThinkingLevel }
  | { type: 'ui_select_response'; requestId: string; selected?: string }
  | { type: 'ui_input_response'; requestId: string; value?: string }
  | { type: 'ui_confirm_response'; requestId: string; confirmed: boolean }
