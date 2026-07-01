import { toast } from "vue-sonner";

type ToastOptions = {
    title: string;
    description?: string;
    color?: "error" | "warning" | "success" | "primary" | "neutral" | "info";
    duration?: number;
};

export function useToast() {
    return {
        add(options: ToastOptions) {
            const message = options.description
                ? `${options.title}: ${options.description}`
                : options.title;
            const config = { duration: options.duration };
            if (options.color === "error") {
                toast.error(message, config);
            }
            else if (options.color === "warning") {
                toast.warning(message, config);
            }
            else if (options.color === "success") {
                toast.success(message, config);
            }
            else if (options.color === "info") {
                toast.info(message, config);
            }
            else {
                toast(message, config);
            }
        },
    };
}
