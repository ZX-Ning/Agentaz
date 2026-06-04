<script setup lang="ts">
import type { AuthLoginRequest, AuthLoginResponse } from "../../types/protocol";
import { apiBase } from "../utils/app.util";

definePageMeta({
  layout: false,
});

declare function useColorMode(): {
  value: string;
  preference: string;
};

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
    await $fetch<AuthLoginResponse>(`${apiBase()}/api/auth/login`, {
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

useHead({
  title: "Agentaz Login",
});
</script>

<template>
  <main
    class="relative flex min-h-screen items-center justify-center bg-background px-4 text-foreground"
  >
    <div class="absolute right-4 top-4">
      <UButton
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

      <UAlert
        v-if="loginError"
        color="error"
        variant="soft"
        title="Login failed"
        :description="loginError"
      />

      <UFormField label="Password">
        <UInput
          v-model="password"
          type="password"
          autocomplete="current-password"
          icon="i-lucide-lock"
          autofocus
          class="w-full"
        />
      </UFormField>

      <UButton
        type="submit"
        block
        color="primary"
        icon="i-lucide-log-in"
        :loading="isLoggingIn"
      >
        Sign in
      </UButton>
    </form>
  </main>
</template>
