import type { AgentStateResponse } from "@agentaz/protocol";
import { nextTick } from "vue";
import {
    browserPathForSession,
    isDraftSessionId,
    routeSessionId,
} from "../utils/app.util.ts";
import type { AgentazContext } from "./agentaz-state.ts";
import { useRoute, useRouter } from "./app-route.ts";
import { useToast } from "./app-toast.ts";

/**
 * Low-level browser-route synchronisation.
 *
 * Split from the higher-level route-apply logic because session operations
 * depend on `syncBrowserRouteToSession`, while `applyBrowserRoute` in turn
 * depends on session operations. Assembling this first breaks that cycle: the
 * controller wires it into the sessions module, then builds the route-apply
 * layer on top of the resulting session functions.
 */
export function createAgentazRouteSync(ctx: AgentazContext) {
    const route = useRoute();
    const router = useRouter();

    async function syncBrowserRouteToSession(
        sessionId?: string | null,
        mode: "push" | "replace" = "replace",
    ) {
        const targetPath = browserPathForSession(sessionId);
        if (route.path === targetPath) {
            return;
        }
        ctx.isSyncingBrowserRoute.value = true;
        try {
            await router[mode](targetPath);
        }
        finally {
            await nextTick();
            ctx.isSyncingBrowserRoute.value = false;
        }
    }

    return { syncBrowserRouteToSession };
}

/**
 * High-level route resolution: maps the current browser path onto a session,
 * activating loaded/persisted sessions or falling back to a fresh draft. Built
 * after the sessions module so it can reuse `focusSession` / `openPersistedSession`.
 */
export function createAgentazRouteApply(
    ctx: AgentazContext,
    deps: {
        syncBrowserRouteToSession: (
            sessionId?: string | null,
            mode?: "push" | "replace",
        ) => Promise<void>;
        refreshSessionDetails: (sessionId: string) => Promise<void>;
        refreshActiveStateDetails: (state: AgentStateResponse) => Promise<void>;
        refreshDraftModelState: (sessionId: string) => Promise<void>;
        createDraftSession: () => string;
        focusSession: (sessionId: string, syncRoute?: boolean) => Promise<void>;
        openPersistedSession: (
            sessionFile: string,
            syncRoute?: boolean,
            expectedSessionId?: string | null,
        ) => Promise<void>;
    },
) {
    const route = useRoute();
    const toast = useToast();
    const {
        syncBrowserRouteToSession,
        refreshSessionDetails,
        refreshActiveStateDetails,
        refreshDraftModelState,
        createDraftSession,
        focusSession,
        openPersistedSession,
    } = deps;

    async function activateSessionFromRoute(sessionId: string) {
        if (
            ctx.activeSessionId.value === sessionId &&
            !isDraftSessionId(sessionId)
        ) {
            await refreshSessionDetails(sessionId);
            return true;
        }

        if (
            ctx.loadedSessions.value.some(
                (session) => session.sessionId === sessionId,
            )
        ) {
            await focusSession(sessionId, false);
            return true;
        }

        const persisted = ctx.persistedSessions.value.find(
            (session) => session.sessionId === sessionId,
        );
        if (!persisted) {
            return false;
        }

        await openPersistedSession(persisted.file, false, sessionId);
        return true;
    }

    async function applyBrowserRoute() {
        const sessionId = routeSessionId(route.path);
        if (sessionId) {
            const activated = await activateSessionFromRoute(sessionId);
            if (activated) {
                return;
            }

            toast.add({
                title: "Session not found",
                description: `No session is available for ${sessionId}.`,
                color: "error",
            });
        }

        await refreshDraftModelState(createDraftSession());
        await syncBrowserRouteToSession(ctx.activeSessionId.value, "replace");
    }

    async function applyInitialRoute(state: AgentStateResponse) {
        const sessionId = routeSessionId(route.path);
        if (sessionId) {
            const activated = await activateSessionFromRoute(sessionId);
            if (!activated) {
                await applyBrowserRoute();
            }
        }
        else {
            await refreshActiveStateDetails(state);
            await syncBrowserRouteToSession(
                ctx.activeSessionId.value,
                "replace",
            );
        }
        ctx.hasAppliedInitialRoute.value = true;
    }

    return {
        activateSessionFromRoute,
        applyBrowserRoute,
        applyInitialRoute,
    };
}
