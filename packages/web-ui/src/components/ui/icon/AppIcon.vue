<script setup lang="ts">
import {
    Activity,
    ArrowDownToLine,
    Brain,
    Check,
    ChevronDown,
    ChevronRight,
    Circle,
    Cpu,
    FlaskConical,
    Layers,
    ListChecks,
    LoaderCircle,
    Lock,
    LogIn,
    LogOut,
    Menu,
    Moon,
    MoreVertical,
    Pencil,
    Plus,
    RotateCcw,
    ShieldAlert,
    Square,
    Sun,
    Trash2,
    X,
} from "lucide-vue-next";

const props = defineProps<{
    name: string;
}>();

const icons: Record<string, unknown> = {
    "i-lucide-activity": Activity,
    "i-lucide-arrow-down-to-line": ArrowDownToLine,
    "i-lucide-brain": Brain,
    "i-lucide-check": Check,
    "i-lucide-chevron-down": ChevronDown,
    "i-lucide-chevron-right": ChevronRight,
    "i-lucide-circle": Circle,
    "i-lucide-cpu": Cpu,
    "i-lucide-flask-conical": FlaskConical,
    "i-lucide-layers": Layers,
    "i-lucide-list-checks": ListChecks,
    "i-lucide-loader-circle": LoaderCircle,
    "i-lucide-lock": Lock,
    "i-lucide-log-in": LogIn,
    "i-lucide-log-out": LogOut,
    "i-lucide-menu": Menu,
    "i-lucide-moon": Moon,
    "i-lucide-more-vertical": MoreVertical,
    "i-lucide-pencil": Pencil,
    "i-lucide-plus": Plus,
    "i-lucide-rotate-ccw": RotateCcw,
    "i-lucide-shield-alert": ShieldAlert,
    "i-lucide-square": Square,
    "i-lucide-sun": Sun,
    "i-lucide-trash-2": Trash2,
    "i-lucide-x": X,
};
</script>

<template>
  <component :is="icons[props.name] || Circle" aria-hidden="true" />
</template>
