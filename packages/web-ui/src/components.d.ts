declare module "vue" {
    export interface GlobalComponents {
        Button: typeof import("./components/ui/Button.vue")["default"];
        Popover: typeof import("./components/ui/Popover.vue")["default"];
        Dialog: typeof import("./components/ui/Dialog.vue")["default"];
        Tooltip: typeof import("./components/ui/Tooltip.vue")["default"];
        AppSelect: typeof import("./components/ui/AppSelect.vue")["default"];
        ContextMenu: typeof import("./components/ui/ContextMenu.vue")[
            "default"
        ];
        AppIcon: typeof import("./components/AppIcon.vue")["default"];
    }
}

export {};
