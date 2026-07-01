import "@fontsource-variable/ibm-plex-sans";
import "katex/dist/katex.min.css";
import "./assets/css/main.css";
import "vue-sonner/style.css";

import { createApp } from "vue";
import App from "./app.vue";
import { initColorMode } from "./composables/app-color-mode.ts";
import Button from "./components/ui/button/Button.vue";
import Input from "./components/ui/input/Input.vue";
import Badge from "./components/ui/badge/Badge.vue";
import Alert from "./components/ui/alert/Alert.vue";
import FormField from "./components/ui/form-field/FormField.vue";
import Popover from "./components/ui/popover/Popover.vue";
import Dialog from "./components/ui/dialog/Dialog.vue";
import Tooltip from "./components/ui/tooltip/Tooltip.vue";
import AppSelect from "./components/ui/select/AppSelect.vue";
import ContextMenu from "./components/ui/context-menu/ContextMenu.vue";
import AppIcon from "./components/ui/icon/AppIcon.vue";

initColorMode();

createApp(App)
    .component("Button", Button)
    .component("Input", Input)
    .component("Badge", Badge)
    .component("Alert", Alert)
    .component("FormField", FormField)
    .component("Popover", Popover)
    .component("Dialog", Dialog)
    .component("Tooltip", Tooltip)
    .component("AppSelect", AppSelect)
    .component("ContextMenu", ContextMenu)
    .component("AppIcon", AppIcon)
    .mount("#app");
