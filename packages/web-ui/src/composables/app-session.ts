import { computed, ref } from "vue";
import { apiFetch } from "./app-fetch.ts";
import { apiBase } from "../utils/app.util.ts";

type User = { id: string };
type SessionResponse = {
    loggedIn: boolean;
    user?: User;
    loggedInAt?: number;
};

const session = ref<SessionResponse>({ loggedIn: false });
const isReady = ref(false);

async function fetchSession() {
    session.value = await apiFetch<SessionResponse>(
        `${apiBase()}/api/_auth/session`,
    );
    isReady.value = true;
    return session.value;
}

export function useUserSession() {
    return {
        loggedIn: computed(() => session.value.loggedIn),
        user: computed(() => session.value.user),
        isReady,
        fetch: fetchSession,
    };
}
