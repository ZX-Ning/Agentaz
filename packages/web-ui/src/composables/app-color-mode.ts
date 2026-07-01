import { computed, reactive } from "vue";

const storageKey = "agentaz-color-mode";
const state = reactive({ preference: "dark" });

function applyColorMode(value: string) {
    document.documentElement.classList.toggle("dark", value === "dark");
}

export function initColorMode() {
    const stored = localStorage.getItem(storageKey);
    state.preference = stored || "dark";
    applyColorMode(state.preference);
}

export function useColorMode() {
    return {
        get value() {
            return state.preference;
        },
        get preference() {
            return state.preference;
        },
        set preference(value: string) {
            state.preference = value;
            localStorage.setItem(storageKey, value);
            applyColorMode(value);
        },
        isDark: computed(() => state.preference === "dark"),
    };
}
