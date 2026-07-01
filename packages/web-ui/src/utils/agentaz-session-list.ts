import type { SessionListItem } from "../types/sessions.ts";
import type { UiLoadedSession, UiSessionSummary } from "@agentaz/protocol";
import { isDraftSessionId, sessionTitle } from "./app.util.ts";

export function findLoadedSessionByFile(
    loadedSessions: UiLoadedSession[],
    file: string,
    indexedByFile?: Map<string, UiLoadedSession>,
) {
    const indexed = indexedByFile?.get(file);
    if (indexed) {
        return indexed;
    }
    return loadedSessions.find(
        (session) =>
            session.sessionFile === file ||
            session.file === file ||
            session.sessionId === file,
    );
}

export function toSessionListItem(
    source: UiLoadedSession | UiSessionSummary,
    activeSessionId: string | null,
    loaded?: UiLoadedSession,
    persisted?: UiSessionSummary,
): SessionListItem {
    const sessionFile = loaded?.sessionFile ??
        loaded?.file ??
        persisted?.file ??
        ("file" in source ? source.file : null);
    const sessionId = loaded?.sessionId ?? null;
    return {
        id: sessionId ?? sessionFile ?? sessionTitle(source),
        file: sessionFile,
        sessionId,
        isDraft: false,
        isLoaded: Boolean(loaded),
        isActive: Boolean(sessionId && sessionId === activeSessionId),
        isWorking: loaded?.isWorking ?? false,
        isStreaming: loaded?.isStreaming ?? false,
        pendingApprovalCount: loaded?.pendingApprovalCount ?? 0,
        title: loaded
            ? sessionTitle({ ...persisted, ...loaded })
            : sessionTitle(source),
        updatedAt: loaded?.updatedAt ??
            persisted?.updatedAt ??
            persisted?.createdAt ??
            ("updatedAt" in source ? source.updatedAt : undefined) ??
            ("createdAt" in source ? source.createdAt : undefined),
    };
}

export function buildUnifiedSessions(
    activeSessionId: string | null,
    loadedSessions: UiLoadedSession[],
    persistedSessions: UiSessionSummary[],
) {
    const list: SessionListItem[] = [];
    const loadedByFile = new Map<string, UiLoadedSession>();

    if (activeSessionId && isDraftSessionId(activeSessionId)) {
        list.push({
            id: activeSessionId,
            file: null,
            sessionId: activeSessionId,
            isDraft: true,
            isLoaded: false,
            isActive: true,
            isWorking: false,
            isStreaming: false,
            pendingApprovalCount: 0,
            title: "New session",
            updatedAt: Date.now(),
        });
    }

    for (const session of loadedSessions) {
        const file = session.sessionFile ?? session.file;
        if (file) {
            loadedByFile.set(file, session);
        }
    }

    for (const persisted of persistedSessions) {
        const loaded = findLoadedSessionByFile(
            loadedSessions,
            persisted.file,
            loadedByFile,
        );
        list.push(
            toSessionListItem(
                loaded ?? persisted,
                activeSessionId,
                loaded,
                persisted,
            ),
        );
    }

    for (const loaded of loadedSessions) {
        const file = loaded.sessionFile ?? loaded.file;
        if (
            file && persistedSessions.some((session) => session.file === file)
        ) {
            continue;
        }
        list.push(toSessionListItem(loaded, activeSessionId, loaded));
    }

    return list.sort(
        (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
}
