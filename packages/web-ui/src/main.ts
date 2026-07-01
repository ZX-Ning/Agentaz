import "@fontsource-variable/ibm-plex-sans";
import "katex/dist/katex.min.css";
import "./assets/css/main.css";
import "vue-sonner/style.css";

import { createApp } from "vue";
import App from "./app.vue";
import { initColorMode } from "./composables/app-color-mode.ts";
import Button from "./components/ui/Button.vue";
import Popover from "./components/ui/Popover.vue";
import Dialog from "./components/ui/Dialog.vue";
import Tooltip from "./components/ui/Tooltip.vue";
import AppSelect from "./components/ui/AppSelect.vue";
import ContextMenu from "./components/ui/ContextMenu.vue";
import AppIcon from "./components/AppIcon.vue";

initColorMode();

createApp(App)
    .component("Button", Button)
    .component("Popover", Popover)
    .component("Dialog", Dialog)
    .component("Tooltip", Tooltip)
    .component("AppSelect", AppSelect)
    .component("ContextMenu", ContextMenu)
    .component("AppIcon", AppIcon)
    .mount("#app");
