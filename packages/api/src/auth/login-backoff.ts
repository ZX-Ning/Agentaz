export type LoginBackoffTiming = {
    now(): number;
    delay(milliseconds: number): Promise<void>;
};

export type LoginBackoffOptions = {
    baseDelayMs: number;
    maxDelayMs: number;
    idleResetMs: number;
};

const DEFAULT_OPTIONS: LoginBackoffOptions = {
    baseDelayMs: 250,
    maxDelayMs: 8_000,
    idleResetMs: 5 * 60_000,
};

const DEFAULT_TIMING: LoginBackoffTiming = {
    now: () => Date.now(),
    delay: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Bounded process-local login backoff for the single admin identity.
 * Attempts are serialized so concurrent requests cannot bypass failure state.
 */
export class LoginBackoff {
    private consecutiveFailures = 0;
    private lastFailureAt?: number;
    private attemptTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly timing: LoginBackoffTiming = DEFAULT_TIMING,
        private readonly options: LoginBackoffOptions = DEFAULT_OPTIONS,
    ) {}

    /** Runs one attempt after applying the delay earned by earlier failures. */
    run<T>(attempt: () => T | Promise<T>): Promise<T> {
        const result = this.attemptTail.then(async () => {
            await this.waitBeforeAttempt();
            return await attempt();
        });
        this.attemptTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** Records a rejected credential attempt. */
    recordFailure() {
        this.resetAfterIdle();
        this.consecutiveFailures += 1;
        this.lastFailureAt = this.timing.now();
    }

    /** Clears accumulated delay after a successful login. */
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.lastFailureAt = undefined;
    }

    /** Read-only state used by deterministic unit tests and diagnostics. */
    snapshot() {
        return {
            consecutiveFailures: this.consecutiveFailures,
            lastFailureAt: this.lastFailureAt,
        };
    }

    private async waitBeforeAttempt() {
        this.resetAfterIdle();
        if (this.consecutiveFailures === 0) {
            return;
        }

        const delayMs = Math.min(
            this.options.baseDelayMs *
                2 ** Math.max(0, this.consecutiveFailures - 1),
            this.options.maxDelayMs,
        );
        await this.timing.delay(delayMs);
    }

    private resetAfterIdle() {
        if (
            this.lastFailureAt !== undefined &&
            this.timing.now() - this.lastFailureAt >=
                this.options.idleResetMs
        ) {
            this.recordSuccess();
        }
    }
}
