export type ApiFetchError = Error & {
    status?: number;
    statusCode?: number;
    data?: unknown;
};

export type ApiFetchOptions = Omit<RequestInit, "body"> & {
    body?: BodyInit | object | null;
};

export async function apiFetch<T>(
    url: string,
    options: ApiFetchOptions = {},
): Promise<T> {
    const headers = new Headers(options.headers);
    let body = options.body as BodyInit | null | undefined;
    if (
        body &&
        typeof body === "object" &&
        !(body instanceof FormData) &&
        !(body instanceof URLSearchParams) &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer)
    ) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(body);
    }

    const response = await fetch(url, {
        ...options,
        headers,
        body,
        credentials: "same-origin",
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

    if (!response.ok) {
        const message = (typeof data === "object" && data && "message" in data
            ? String(data.message)
            : undefined) || response.statusText;
        const error = new Error(message) as ApiFetchError;
        error.status = response.status;
        error.statusCode = response.status;
        error.data = data;
        throw error;
    }

    return data as T;
}
