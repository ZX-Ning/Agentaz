import type { ExtensionUIDialogOptions, TerminalInputHandler, WorkingIndicatorOptions } from '@earendil-works/pi-coding-agent'
import type { ServerEvent } from '../../types/protocol'

type SendEvent = (event: ServerEvent) => void

type PendingRequest = {
  kind: 'select' | 'input' | 'confirm'
  resolve: (value: unknown) => void
  timer: NodeJS.Timeout
}

export class WebExtensionUIContext {
  private pending = new Map<string, PendingRequest>()

  constructor(
    private readonly send: SendEvent,
    private readonly timeoutMs: number,
  ) {}

  async select(title: string, options: string[], _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.request<string | undefined>('select', {
      type: 'ui_select_request',
      requestId: crypto.randomUUID(),
      title,
      options,
      timeoutMs: this.timeoutMs,
    })
  }

  async confirm(title: string, message: string, _opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.request<boolean>('confirm', {
      type: 'ui_confirm_request',
      requestId: crypto.randomUUID(),
      title,
      message,
      timeoutMs: this.timeoutMs,
    }, false)
  }

  async input(title: string, placeholder?: string, _opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.request<string | undefined>('input', {
      type: 'ui_input_request',
      requestId: crypto.randomUUID(),
      title,
      placeholder,
      timeoutMs: this.timeoutMs,
    })
  }

  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    this.send({ type: 'ui_notify', message, level: type })
  }

  resolveSelect(requestId: string, selected?: string) {
    this.resolve(requestId, selected)
  }

  resolveInput(requestId: string, value?: string) {
    this.resolve(requestId, value)
  }

  resolveConfirm(requestId: string, confirmed: boolean) {
    this.resolve(requestId, confirmed)
  }

  cancelAll() {
    for (const requestId of this.pending.keys()) {
      this.resolve(requestId, undefined)
    }
  }

  onTerminalInput(_handler: TerminalInputHandler): () => void {
    return () => {}
  }

  setStatus(_key: string, _text: string | undefined): void {}
  setWorkingMessage(_message?: string): void {}
  setWorkingVisible(_visible: boolean): void {}
  setWorkingIndicator(_options?: WorkingIndicatorOptions): void {}
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
