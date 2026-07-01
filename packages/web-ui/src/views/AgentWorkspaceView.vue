<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { apiBase } from "../utils/app.util";
import { apiFetch } from "../composables/app-fetch";
import { useRoute, useRouter } from "../composables/app-route";
import { useUserSession } from "../composables/app-session";
import { useToast } from "../composables/app-toast";
import AgentWorkspace from "../components/AgentWorkspace.vue";

const toast = useToast();
const route = useRoute();
const router = useRouter();
const { fetch: refreshUserSession } = useUserSession();

/**
 * Builds a same-origin login redirect for the route that just lost auth.
 *
 * The root route does not need an explicit redirect because successful login
 * already lands on `/` by default.
 */
function loginRouteForCurrentLocation() {
  if (route.fullPath === "/") return "/login";
  return {
    path: "/login",
    query: { redirect: route.fullPath },
  };
}

/**
 * Ends the encrypted session, refreshes client session state,
 * and returns the browser to the public login route.
 */
async function logout() {
  try {
    await apiFetch(`${apiBase()}/api/auth/logout`, { method: "POST" });
    await refreshUserSession();
    await router.replace("/login");
  } catch (error) {
    const data = (error as any)?.data?.data ?? (error as any)?.data;
    toast.add({
      title: data?.code ?? "logout_failed",
      description:
        data?.message ??
        (error instanceof Error ? error.message : "Logout failed."),
      color: "error",
    });
  }
}

/**
 * Handles auth expiry discovered by the HTTP/WS app controller after the page
 * is mounted. This path is separate from route middleware because expiry can
 * happen while the user stays on the same route.
 */
async function handleAuthExpired() {
  toast.add({
    title: "Session expired",
    description: "Sign in again to continue.",
    color: "warning",
  });
  await refreshUserSession();
  await router.replace(loginRouteForCurrentLocation());
}

onMounted(() => {
  window.addEventListener("agentaz-auth-expired", handleAuthExpired);
});

onBeforeUnmount(() => {
  window.removeEventListener("agentaz-auth-expired", handleAuthExpired);
});
</script>

<template>
  <AgentWorkspace @logout="logout" />
</template>
