<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Toaster } from "vue-sonner";
import AgentWorkspaceView from "./views/AgentWorkspaceView.vue";
import LoginView from "./views/LoginView.vue";
import { useRoute, useRouter } from "./composables/app-route";
import { useUserSession } from "./composables/app-session";

const route = useRoute();
const router = useRouter();
const { loggedIn, fetch: refreshUserSession } = useUserSession();
const isBootstrapping = ref(true);

const currentView = computed(() =>
    route.path === "/login" ? LoginView : AgentWorkspaceView
);

function loginRouteForCurrentLocation() {
    if (route.fullPath === "/" || route.path === "/login") return "/login";
    return { path: "/login", query: { redirect: route.fullPath } };
}

function safeLoginRedirect() {
    const rawRedirect = route.query.redirect;
    const redirect = Array.isArray(rawRedirect) ? rawRedirect[0] : rawRedirect;
    if (
        typeof redirect === "string" &&
        redirect.startsWith("/") &&
        !redirect.startsWith("//") &&
        redirect !== "/login"
    ) {
        return redirect;
    }
    return "/";
}

async function applyAuthRoute() {
    if (!loggedIn.value && route.path !== "/login") {
        await router.replace(loginRouteForCurrentLocation());
        return;
    }
    if (loggedIn.value && route.path === "/login") {
        await router.replace(safeLoginRedirect());
    }
}

onMounted(async () => {
    await refreshUserSession();
    await applyAuthRoute();
    isBootstrapping.value = false;
});

watch(() => route.fullPath, () => {
    if (!isBootstrapping.value) void applyAuthRoute();
});

watch(loggedIn, () => {
    if (!isBootstrapping.value) void applyAuthRoute();
});
</script>

<template>
  <div v-if="isBootstrapping" class="min-h-screen bg-background" />
  <component :is="currentView" v-else />
  <Toaster position="top-right" rich-colors />
</template>
