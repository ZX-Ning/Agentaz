import type {
    ThinkingLevel,
    UiBlock,
    UiLoadedSession,
    UiModel,
    UiSessionSummary,
} from "../../types/protocol";

export type SessionModelState = {
    models: UiModel[];
    currentModel: UiModel | null;
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
    pendingModelChange: boolean;
    pendingThinkingChange: boolean;
};

export const DRAFT_SESSION_PREFIX = "draft-session-";

export const thinkingOptions: Array<{ value: ThinkingLevel; label: string }> = [
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
];

export function defaultModelState(): SessionModelState {
    return {
        models: [],
        currentModel: null,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        pendingModelChange: false,
        pendingThinkingChange: false,
    };
}

export function isDraftSessionId(sessionId?: string | null) {
    return Boolean(sessionId?.startsWith(DRAFT_SESSION_PREFIX));
}

export function routeSessionId(path: string) {
    const match = /^\/session\/([^/]+)\/?$/.exec(path);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function browserPathForSession(sessionId?: string | null) {
    if (!sessionId || isDraftSessionId(sessionId)) return "/";
    return `/session/${encodeURIComponent(sessionId)}`;
}

export function createDraftSessionId() {
    return `${DRAFT_SESSION_PREFIX}${Date.now()}`;
}

export function modelKey(model: UiModel) {
    return JSON.stringify([model.provider, model.id]);
}

/**
 * Runtime-aware base path for API calls.
 *
 * Reads from Nuxt's runtimeConfig.app.baseURL, which is automatically
 * overridden by the NUXT_APP_BASE_URL environment variable at runtime.
 * Returns "" when baseURL is "/" so existing "/api/..." concatenation
 * produces clean absolute paths for the default root deployment.
 */
export function apiBase(): string {
    const base = useRuntimeConfig().app.baseURL as string;
    return base === "/" ? "" : base.replace(/\/$/, "");
}

export function sessionUrl(sessionId: string, suffix = "") {
    return `/api/agent/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export function sessionTitle(session: UiLoadedSession | UiSessionSummary) {
    return (
        session.name ||
        session.firstMessage ||
        (session.sessionId ? session.sessionId.slice(0, 8) : "Untitled session")
    );
}

export function closestThinkingLevel(
    level: ThinkingLevel,
    availableLevels: ThinkingLevel[],
) {
    if (availableLevels.includes(level)) return level;
    const requestedIndex = thinkingOptions.findIndex(
        option => option.value === level,
    );
    for (let index = requestedIndex; index < thinkingOptions.length; index++) {
        const option = thinkingOptions[index];
        if (option && availableLevels.includes(option.value))
            return option.value;
    }
    for (let index = requestedIndex - 1; index >= 0; index--) {
        const option = thinkingOptions[index];
        if (option && availableLevels.includes(option.value))
            return option.value;
    }
    return availableLevels[0] ?? "off";
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return thinkingOptions.some(option => option.value === value);
}

export function areSameToolBlock(left: UiBlock, right: UiBlock) {
    if (left.type === "tool_call" && right.type === "tool_call")
        return left.toolCallId === right.toolCallId;
    if (left.type === "tool_result" && right.type === "tool_result")
        return left.toolCallId === right.toolCallId;
    return false;
}
