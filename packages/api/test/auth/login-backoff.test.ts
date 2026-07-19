import assert from "node:assert/strict";
import { LoginBackoff } from "../../src/auth/login-backoff.ts";

Deno.test("login backoff progresses, caps, resets, and expires after idle", async () => {
    let now = 0;
    const delays: number[] = [];
    const backoff = new LoginBackoff(
        {
            now: () => now,
            delay: (milliseconds) => {
                delays.push(milliseconds);
                return Promise.resolve();
            },
        },
        { baseDelayMs: 100, maxDelayMs: 400, idleResetMs: 1_000 },
    );
    const attempt = (succeeds: boolean) =>
        backoff.run(() => {
            if (succeeds) {
                backoff.recordSuccess();
            }
            else {
                backoff.recordFailure();
            }
        });

    await attempt(false);
    await attempt(false);
    await attempt(false);
    await attempt(false);
    await attempt(false);
    assert.deepEqual(delays, [100, 200, 400, 400]);
    assert.equal(backoff.snapshot().consecutiveFailures, 5);

    await attempt(true);
    assert.deepEqual(delays, [100, 200, 400, 400, 400]);
    assert.equal(backoff.snapshot().consecutiveFailures, 0);
    await attempt(false);
    assert.deepEqual(delays, [100, 200, 400, 400, 400]);

    now += 1_000;
    await attempt(false);
    assert.deepEqual(delays, [100, 200, 400, 400, 400]);
    assert.equal(backoff.snapshot().consecutiveFailures, 1);
});
