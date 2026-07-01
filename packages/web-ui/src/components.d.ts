declare module "vue" {
    export interface GlobalComponents {
        Button: typeof import("./components/ui/button/Button.vue")["default"];
        Input: typeof import("./components/ui/input/Input.vue")["default"];
        Badge: typeof import("./components/ui/badge/Badge.vue")["default"];
        Alert: typeof import("./components/ui/alert/Alert.vue")["default"];
        FormField: typeof import("./components/ui/form-field/FormField.vue")[
            "default"
        ];
        Popover:
            typeof import("./components/ui/popover/Popover.vue")["default"];
        Dialog: typeof import("./components/ui/dialog/Dialog.vue")["default"];
        Tooltip:
            typeof import("./components/ui/tooltip/Tooltip.vue")["default"];
        AppSelect:
            typeof import("./components/ui/select/AppSelect.vue")["default"];
        ContextMenu:
            typeof import("./components/ui/context-menu/ContextMenu.vue")[
                "default"
            ];
        AppIcon: typeof import("./components/ui/icon/AppIcon.vue")["default"];
    }
}

export {};
