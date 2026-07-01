/** Structured JSON error payload returned by Agentaz HTTP APIs. */
export type ApiErrorData = {
    code: string;
    message: string;
    recoverable: boolean;
};

export class HttpError extends Error {
    readonly status: number;
    readonly data: ApiErrorData;

    constructor(status: number, message: string, data: ApiErrorData) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.data = data;
    }
}

export function jsonError(status: number, code: string, message: string) {
    return new HttpError(status, message, {
        code,
        message,
        recoverable: status < 500,
    });
}
