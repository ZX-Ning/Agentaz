export const PROTOCOL_VERSION = 1

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ImagePayload = {
  mediaType: string
  data: string
}

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

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: UiBlock[]
  createdAt?: number
}

export type UiSessionSummary = {
  file: string
  name?: string
  createdAt?: number
  updatedAt?: number
  firstMessage?: string
}

export type UiModel = {
  provider: string
  id: string
  name?: string
}

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

export type ServerErrorEvent = {
  type: 'error'
  code: string
  message: string
  recoverable: boolean
}

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
  | { type: 'model_list_result'; models: UiModel[]; current?: UiModel }
  | { type: 'model_changed'; model: UiModel; pending?: boolean }
  | { type: 'thinking_changed'; level: ThinkingLevel; pending?: boolean }
  | { type: 'ui_select_request'; requestId: string; title: string; options: string[]; timeoutMs: number }
  | { type: 'ui_input_request'; requestId: string; title: string; placeholder?: string; timeoutMs: number }
  | { type: 'ui_confirm_request'; requestId: string; title: string; message: string; timeoutMs: number }
  | { type: 'ui_notify'; message: string; level?: 'info' | 'warning' | 'error' }
  | { type: 'status'; isStreaming: boolean; pendingMessageCount: number }
  | ServerErrorEvent

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
