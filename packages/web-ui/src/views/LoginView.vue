<script setup lang="ts">
import { computed, ref } from "vue";
import type { AuthLoginRequest, AuthLoginResponse } from "@agentaz/protocol";
import { apiBase } from "../utils/app.util";
import { apiFetch } from "../composables/app-fetch";
import { setDocumentTitle } from "../composables/app-head";
import { useColorMode } from "../composables/app-color-mode";
import { useRoute, useRouter } from "../composables/app-route";
import { useUserSession } from "../composables/app-session";

const { fetch: refreshUserSession } = useUserSession();
const route = useRoute();
const router = useRouter();
const colorMode = useColorMode();

const password = ref("");
const isLoggingIn = ref(false);
const loginError = ref<string | null>(null);
const isDark = computed(() => colorMode.value === "dark");
const safeLoginRedirect = computed(() => {
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
});

function toggleTheme() {
  colorMode.preference = isDark.value ? "light" : "dark";
}

async function login() {
  const body: AuthLoginRequest = { password: password.value };
  if (!body.password) {
    loginError.value = "Password is required.";
    return;
  }

  isLoggingIn.value = true;
  loginError.value = null;
  try {
    await apiFetch<AuthLoginResponse>(`${apiBase()}/api/auth/login`, {
      method: "POST",
      body,
    });
    password.value = "";
    await refreshUserSession();
    await router.replace(safeLoginRedirect.value);
  } catch (error) {
    const data = (error as any)?.data?.data ?? (error as any)?.data;
    loginError.value =
      data?.message ??
      (error instanceof Error ? error.message : "Login failed.");
  } finally {
    isLoggingIn.value = false;
  }
}

setDocumentTitle("Agentaz Login");
</script>

<template>
  <main
    class="relative flex min-h-screen items-center justify-center bg-background px-4 text-foreground"
  >
    <div class="absolute right-4 top-4">
      <Button
        color="neutral"
        variant="ghost"
        :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
        size="sm"
        class="text-foreground hover:bg-accent hover:text-accent-foreground"
        @click="toggleTheme"
      />
    </div>

    <form
      class="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm"
      @submit.prevent="login"
    >
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <div
            class="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
          >
            AZ
          </div>
          <h1 class="text-lg font-semibold">Agentaz</h1>
        </div>
        <p class="text-sm text-muted-foreground">
          Enter the admin password to continue.
        </p>
      </div>

      <div
        v-if="loginError"
        class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <div class="font-medium">Login failed</div>
        <div class="mt-1 text-xs opacity-90">{{ loginError }}</div>
      </div>

      <label class="grid gap-2 text-sm font-medium text-foreground">
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>

      <Button
        type="submit"
        block
        color="primary"
        icon="i-lucide-log-in"
        :loading="isLoggingIn"
      >
        Sign in
      </Button>
    </form>
  </main>
</template>
