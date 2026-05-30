/**
 * Runtime UI representation of a session in the sidebar list.
 *
 * This is a frontend-only type — the backend sends UiLoadedSession and
 * UiSessionSummary, and the frontend merges them into this combined view.
 */
export type SessionListItem = {
  /** Unique list item id (may be the session file path or session id). */
  id: string;
  /** Session file path, or null for ephemeral sessions. */
  file: string | null;
  /** Pi session identifier. */
  sessionId: string | null;
  /** Whether this is an unsaved draft session. */
  isDraft: boolean;
  /** Whether the session is currently loaded in the server process. */
  isLoaded: boolean;
  /** Whether this session is the active/focused session for the current tab. */
  isActive: boolean;
  /** Whether the session is currently busy (streaming, pending approvals). */
  isWorking: boolean;
  /** Whether the Pi agent is currently streaming response text. */
  isStreaming: boolean;
  /** Number of browser-backed UI prompts awaiting response. */
  pendingApprovalCount: number;
  /** Display title for the sidebar row. */
  title: string;
  /** Last modification timestamp for sorting. */
  updatedAt?: number;
};
