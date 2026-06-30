import type {
    ExtensionUIDialogOptions,
    TerminalInputHandler,
    WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type {
    PendingUiRequest,
    ServerEvent,
    UiExtensionWidget,
} from "@agentaz/protocol";

/** Emits a normalized server event to browser realtime subscribers. */
type SendEvent = (event: ServerEvent) => void;

/** Tracks one outstanding browser-backed extension UI request until it resolves or times out. */
type PendingRequest = {
    kind: "select" | "input" | "confirm";
    event: PendingUiRequest;
    resolve: (value: unknown) => void;
    timer: NodeJS.Timeout;
};

/** Minimal state for a widget registered by an extension UI context. */
type RegisteredWidget = UiExtensionWidget & {
    dispose?: () => void;
    render?: () => string[];
};

const DEFAULT_WIDGET_PLACEMENT: UiExtensionWidget["placement"] = "aboveEditor";
const DEFAULT_WIDGET_WIDTH = 88;

/**
 * Per-session Pi extension UI bridge; not a singleton.
 * Converts extension prompts/widgets into browser events and resolves replies.
 * Pending prompts always resolve: response, timeout, or `cancelAll()`.
 */
export class WebExtensionUIContext {
    private pending = new Map<string, PendingRequest>();
    private widgets = new Map<string, RegisteredWidget>();

    constructor(
        private readonly sessionId: string,
        private readonly send: SendEvent,
        private readonly timeoutMs: number,
        private readonly onPendingChange?: () => void,
    ) {}

    /** Number of browser-backed UI requests still waiting for a response. */
    get pendingCount() {
        return this.pending.size;
    }

    /** Returns the prompt details required to render all outstanding browser approvals. */
    get pendingRequests(): PendingUiRequest[] {
        return [...this.pending.values()].map(request => ({
            ...request.event,
        }));
    }

    /** Returns a browser-safe snapshot of currently registered extension widgets. */
    get extensionWidgets(): UiExtensionWidget[] {
        return [...this.widgets.values()].map(({ key, placement, lines }) => ({
            key,
            placement,
            lines: [...lines],
        }));
    }

    /** Shows a single-choice prompt in the browser and resolves with the selected option. */
    async select(
        title: string,
        options: string[],
        _opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined> {
        return this.request<string | undefined>("select", {
            type: "ui_select_request",
            sessionId: this.sessionId,
            requestId: crypto.randomUUID(),
            title,
            options,
            timeoutMs: this.timeoutMs,
        });
    }

    /** Shows a confirmation prompt in the browser and resolves to false if it times out. */
    async confirm(
        title: string,
        message: string,
        _opts?: ExtensionUIDialogOptions,
    ): Promise<boolean> {
        return this.request<boolean>(
            "confirm",
            {
                type: "ui_confirm_request",
                sessionId: this.sessionId,
                requestId: crypto.randomUUID(),
                title,
                message,
                timeoutMs: this.timeoutMs,
            },
            false,
        );
    }

    /** Shows a text input prompt in the browser and resolves with the submitted value. */
    async input(
        title: string,
        placeholder?: string,
        _opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined> {
        return this.request<string | undefined>("input", {
            type: "ui_input_request",
            sessionId: this.sessionId,
            requestId: crypto.randomUUID(),
            title,
            placeholder,
            timeoutMs: this.timeoutMs,
        });
    }

    /** Forwards extension notifications to the browser notification/toast stream. */
    notify(message: string, type?: "info" | "warning" | "error"): void {
        this.send({
            type: "ui_notify",
            sessionId: this.sessionId,
            message,
            level: type,
        });
    }

    /** Resolves a pending select request from a browser response event. */
    resolveSelect(requestId: string, selected?: string) {
        this.resolve(requestId, selected);
    }

    /** Resolves a pending input request from a browser response event. */
    resolveInput(requestId: string, value?: string) {
        this.resolve(requestId, value);
    }

    /** Resolves a pending confirm request from a browser response event. */
    resolveConfirm(requestId: string, confirmed: boolean) {
        this.resolve(requestId, confirmed);
    }

    /** Cancels every pending browser prompt so extension code cannot hang after disconnect or abort. */
    cancelAll() {
        for (const requestId of this.pending.keys()) {
            this.resolve(requestId, undefined);
        }
    }

    /** Terminal input is not exposed in the web MVP; return a no-op unsubscribe function. */
    onTerminalInput(_handler: TerminalInputHandler): () => void {
        return () => {};
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
    /** Renders extension widgets as plain text lines in the browser. */
    setWidget(
        key: string,
        content: string[] | ((tui: any, theme: any) => any) | undefined,
        options?: { placement?: UiExtensionWidget["placement"] },
    ): void {
        this.widgets.get(key)?.dispose?.();
        this.widgets.delete(key);

        if (content === undefined) {
            this.send({
                type: "extension_widget_update",
                sessionId: this.sessionId,
                key,
            });
            return;
        }

        const placement = options?.placement ?? DEFAULT_WIDGET_PLACEMENT;
        if (Array.isArray(content)) {
            this.setWidgetLines(key, placement, content);
            return;
        }

        // eslint-disable-next-line prefer-const -- requestRender may run while content constructs the component.
        let component: any;
        const emitWidget = () => {
            try {
                const rendered = component?.render?.(DEFAULT_WIDGET_WIDTH);
                this.setWidgetLines(
                    key,
                    placement,
                    Array.isArray(rendered) ? rendered : [],
                );
            } catch (error) {
                this.notify(
                    error instanceof Error ? error.message : String(error),
                    "error",
                );
            }
        };
        const tui = { requestRender: emitWidget };
        component = content(tui, plainTheme());
        this.widgets.set(key, {
            key,
            placement,
            lines: [],
            dispose: component?.dispose?.bind(component),
            render: () => component?.render?.(DEFAULT_WIDGET_WIDTH) ?? [],
        });
        emitWidget();
    }

    private request<T>(
        kind: PendingRequest["kind"],
        event: PendingUiRequest,
        fallback?: T,
    ): Promise<T> {
        const requestId = event.requestId;

        return new Promise<T>(resolve => {
            const timer = setTimeout(() => {
                this.resolve(requestId, fallback);
            }, this.timeoutMs);

            this.pending.set(requestId, {
                kind,
                event,
                resolve: resolve as (value: unknown) => void,
                timer,
            });
            this.onPendingChange?.();
            this.send(event);
        });
    }

    private resolve(requestId: string, value: unknown) {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        this.onPendingChange?.();
        pending.resolve(value);
    }

    private setWidgetLines(
        key: string,
        placement: UiExtensionWidget["placement"],
        lines: string[],
    ) {
        const widget = {
            key,
            placement,
            lines: [...lines],
            dispose: this.widgets.get(key)?.dispose,
            render: this.widgets.get(key)?.render,
        };
        this.widgets.set(key, widget);
        this.send({
            type: "extension_widget_update",
            sessionId: this.sessionId,
            key,
            placement,
            lines: widget.lines,
        });
    }
}

function plainTheme() {
    const passthrough = (text: string) => text;
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: passthrough,
        italic: passthrough,
        underline: passthrough,
        inverse: passthrough,
        strikethrough: passthrough,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        getColorMode: () => "truecolor",
        getThinkingBorderColor: () => passthrough,
        getBashModeBorderColor: () => passthrough,
    };
}
