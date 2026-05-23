import type { ExtensionUIDialogOptions, TerminalInputHandler, WorkingIndicatorOptions } from '@earendil-works/pi-coding-agent'
import type { ServerEvent } from '../../types/protocol'

/** Emits a normalized server event to the active WebSocket client. */
type SendEvent = (event: ServerEvent) => void

/** Tracks one outstanding browser-backed extension UI request until it resolves or times out. */
type PendingRequest = {
  kind: 'select' | 'input' | 'confirm'
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

/**
 * Browser-backed implementation of the Pi extension UI surface.
 *
 * Pi extensions expect synchronous-looking UI helpers such as select, input, and confirm. This class
 * translates those helpers into WebSocket request events and resolves the returned promises when the
 * browser sends a matching response. Requests must always resolve, so each pending prompt has a timeout
 * and `cancelAll()` is called when the user disconnects or aborts the agent workflow.
 */
export class WebExtensionUIContext {
  private pending = new Map<string, PendingRequest>()

  constructor(
    private readonly sessionId: string,
    private readonly send: SendEvent,
    private readonly timeoutMs: number,
  ) {}

  /** Number of browser-backed UI requests still waiting for a response. */
  get pendingCount() {
    return this.pending.size
  }

  /** Shows a single-choice prompt in the browser and resolves with the selected option. */
  async select(title: string, options: string[], _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.request<string | undefined>('select', {
      type: 'ui_select_request',
      sessionId: this.sessionId,
      requestId: crypto.randomUUID(),
      title,
      options,
      timeoutMs: this.timeoutMs,
    })
  }

  /** Shows a confirmation prompt in the browser and resolves to false if it times out. */
  async confirm(title: string, message: string, _opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.request<boolean>('confirm', {
      type: 'ui_confirm_request',
      sessionId: this.sessionId,
      requestId: crypto.randomUUID(),
      title,
      message,
      timeoutMs: this.timeoutMs,
    }, false)
  }

  /** Shows a text input prompt in the browser and resolves with the submitted value. */
  async input(title: string, placeholder?: string, _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.request<string | undefined>('input', {
      type: 'ui_input_request',
      sessionId: this.sessionId,
      requestId: crypto.randomUUID(),
      title,
      placeholder,
      timeoutMs: this.timeoutMs,
    })
  }

  /** Forwards extension notifications to the browser notification/toast stream. */
  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    this.send({ type: 'ui_notify', sessionId: this.sessionId, message, level: type })
  }

  /** Resolves a pending select request from a browser response event. */
  resolveSelect(requestId: string, selected?: string) {
    this.resolve(requestId, selected)
  }

  /** Resolves a pending input request from a browser response event. */
  resolveInput(requestId: string, value?: string) {
    this.resolve(requestId, value)
  }

  /** Resolves a pending confirm request from a browser response event. */
  resolveConfirm(requestId: string, confirmed: boolean) {
    this.resolve(requestId, confirmed)
  }

  /** Cancels every pending browser prompt so extension code cannot hang after disconnect or abort. */
  cancelAll() {
    for (const requestId of this.pending.keys()) {
      this.resolve(requestId, undefined)
    }
  }

  /** Terminal input is not exposed in the web MVP; return a no-op unsubscribe function. */
  onTerminalInput(_handler: TerminalInputHandler): () => void {
    return () => {}
  }

  /** Status widgets are not rendered by the web MVP yet. */
  setStatus(_key: string, _text: string | undefined): void {}
  /** Working messages are not rendered by the web MVP yet. */
  setWorkingMessage(_message?: string): void {}
  /** Working indicator visibility is not rendered by the web MVP yet. */
  setWorkingVisible(_visible: boolean): void {}
  /** Custom working indicators are not rendered by the web MVP yet. */
  setWorkingIndicator(_options?: WorkingIndicatorOptions): void {}
  /** Hidden-thinking labels are not rendered by the web MVP yet. */
  setHiddenThinkingLabel(_label?: string): void {}

  private request<T>(kind: PendingRequest['kind'], event: Extract<ServerEvent, { requestId: string }>, fallback?: T): Promise<T> {
    const requestId = event.requestId

    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.resolve(requestId, fallback)
      }, this.timeoutMs)

      this.pending.set(requestId, { kind, resolve: resolve as (value: unknown) => void, timer })
      this.send(event)
    })
  }

  private resolve(requestId: string, value: unknown) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(value)
  }
}
