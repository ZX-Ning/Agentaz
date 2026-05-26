<script setup lang="ts">
function pageKey(route: { path: string }) {
  return route.path === "/login" ? "login" : "agent-workspace";
}
</script>

<template>
  <UApp>
    <NuxtPage :page-key="pageKey" />
  </UApp>
</template>
