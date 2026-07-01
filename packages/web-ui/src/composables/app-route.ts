import { reactive, readonly } from "vue";

type RouteLocation = {
    path: string;
    fullPath: string;
    query: Record<string, string | string[]>;
};

type RouteTarget = string | { path: string; query?: Record<string, string> };

const route = reactive<RouteLocation>(readLocation());
let isListening = false;

function readLocation(): RouteLocation {
    const url = new URL(window.location.href);
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of url.searchParams) {
        const current = query[key];
        if (Array.isArray(current)) {
            current.push(value);
        }
        else if (typeof current === "string") {
            query[key] = [current, value];
        }
        else {
            query[key] = value;
        }
    }
    return {
        path: url.pathname || "/",
        fullPath: `${url.pathname}${url.search}${url.hash}`,
        query,
    };
}

function syncRoute() {
    Object.assign(route, readLocation());
}

function ensureListener() {
    if (isListening) {
        return;
    }
    window.addEventListener("popstate", syncRoute);
    isListening = true;
}

function targetToPath(target: RouteTarget) {
    if (typeof target === "string") {
        return target;
    }
    const params = new URLSearchParams(target.query);
    const query = params.toString();
    return query ? `${target.path}?${query}` : target.path;
}

export function useRoute() {
    ensureListener();
    return readonly(route);
}

export function useRouter() {
    ensureListener();
    return {
        async push(target: RouteTarget) {
            history.pushState({}, "", targetToPath(target));
            syncRoute();
        },
        async replace(target: RouteTarget) {
            history.replaceState({}, "", targetToPath(target));
            syncRoute();
        },
    };
}
