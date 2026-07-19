import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
    createSessionController,
    type CreateSessionControllerOptions,
    openSessionController,
} from "../../src/pi/session-controller.ts";

/**
 * Factory coverage: creating a manager-backed controller must not load SDK
 * services until an operation needs the live Pi session.
 */
Deno.test("createSessionController initializes the live session lazily", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Deno.mkdir(cwd, { recursive: true });

    const initializationError = new Error("create services requested");
    const harness = factoryHarness(cwd, agentDir);
    let sessionFile: string | undefined;

    try {
        const controller = createSessionController(harness.options);

        assert.equal(harness.createServicesCalls(), 0);
        assert.equal(controller.session, undefined);
        assert.equal(
            controller.sessionId,
            controller.getSessionManager().getSessionId(),
        );
        assert.equal(
            controller.sessionFile,
            controller.getSessionManager().getSessionFile(),
        );
        sessionFile = controller.sessionFile;
        assert.ok(sessionFile);
        // Pi defers a new JSONL file until an assistant response is persisted.
        assert.equal(await isFile(sessionFile), false);

        const manager = controller.getSessionManager();
        manager.appendMessage(testMessage("user", "New question"));
        assert.equal(await isFile(sessionFile), false);
        manager.appendMessage(testMessage("assistant", "New answer"));

        assert.ok(await isFile(sessionFile));
        const persistedManager = SessionManager.open(
            sessionFile,
            undefined,
            cwd,
        );
        assert.equal(persistedManager.getSessionId(), controller.sessionId);
        assert.equal(persistedManager.getBranch().length, 2);

        const abort = controller.abort();
        await harness.servicesRequested;
        harness.rejectServices(initializationError);

        await assert.rejects(() => abort, initializationError);
        assert.equal(harness.createServicesCalls(), 1);

        await controller.dispose();
    }
    finally {
        if (sessionFile && await isFile(sessionFile)) {
            await Deno.remove(sessionFile);
        }
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Factory + dedup coverage: opening history stays dormant, while concurrent
 * first live operations share one initialization attempt.
 */
Deno.test("openSessionController lazily deduplicates live initialization", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    await Deno.mkdir(cwd, { recursive: true });

    const sourceManager = SessionManager.create(cwd, sessionDir);
    sourceManager.appendMessage(testMessage("user", "Existing question"));
    sourceManager.appendMessage(testMessage("assistant", "Existing answer"));
    sourceManager.appendSessionInfo("Existing session");
    const sessionFile = sourceManager.getSessionFile();
    assert.ok(sessionFile);
    assert.ok(await isFile(sessionFile));

    const persistedEntries = (await Deno.readTextFile(sessionFile)).trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
    assert.equal(persistedEntries[0]?.type, "session");
    assert.ok(persistedEntries.some((entry) => entry.type === "message"));

    const initializationError = new Error("open services requested");
    const harness = factoryHarness(cwd, agentDir);

    try {
        const controller = openSessionController({
            ...harness.options,
            sessionFile,
        });

        assert.equal(harness.createServicesCalls(), 0);
        assert.equal(controller.session, undefined);
        assert.equal(
            controller.getHistory().sessionId,
            sourceManager.getSessionId(),
        );
        assert.equal(harness.createServicesCalls(), 0);

        const abort = controller.abort();
        const clearQueue = controller.clearQueue();
        await harness.servicesRequested;
        harness.rejectServices(initializationError);

        const results = await Promise.allSettled([abort, clearQueue]);
        assert.deepEqual(
            results.map((result) =>
                result.status === "rejected" ? result.reason : undefined
            ),
            [initializationError, initializationError],
        );
        assert.equal(harness.createServicesCalls(), 1);

        await controller.dispose();
    }
    finally {
        await Deno.remove(root, { recursive: true });
    }
});

/**
 * Purpose: Verify a failed lazy initialization clears both service/init caches so
 * a later operation can make a fresh attempt instead of reusing rejection forever.
 * Expect: Two sequential operations receive distinct failures and createServices runs twice.
 * Method: Reject each host service request with a different error and call abort twice.
 */
Deno.test("PiSessionController retries initialization after service failure", async () => {
    const root = await Deno.makeTempDir();
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Deno.mkdir(cwd, { recursive: true });
    const failures = [new Error("first failure"), new Error("second failure")];
    let calls = 0;
    const controller = createSessionController({
        cwd,
        agentDir,
        authStorage: undefined as never,
        modelRegistry: undefined as never,
        approvalTimeoutMs: 100,
        host: {
            createServices: () =>
                Promise.reject(failures[calls++] ?? failures[1]),
            emit: () => {},
            onSessionMetadataChanged: () => {},
        },
    });

    try {
        await assert.rejects(
            () => controller.abort(),
            (error) => error === failures[0],
        );
        assert.equal(controller.session, undefined);
        await assert.rejects(
            () => controller.abort(),
            (error) => error === failures[1],
        );
        assert.equal(controller.session, undefined);
        assert.equal(calls, 2);
    }
    finally {
        await controller.dispose();
        await Deno.remove(root, { recursive: true });
    }
});

function factoryHarness(cwd: string, agentDir: string) {
    const services = Promise.withResolvers<never>();
    const serviceRequested = Promise.withResolvers<void>();
    let calls = 0;
    const options: CreateSessionControllerOptions = {
        cwd,
        agentDir,
        // SDK backing objects are intentionally unused before createServices().
        authStorage: undefined as never,
        modelRegistry: undefined as never,
        approvalTimeoutMs: 100,
        host: {
            createServices: () => {
                calls += 1;
                serviceRequested.resolve();
                return services.promise;
            },
            emit: () => {},
            onSessionMetadataChanged: () => {},
        },
    };

    return {
        options,
        createServicesCalls: () => calls,
        servicesRequested: serviceRequested.promise,
        rejectServices: (error: unknown) => services.reject(error),
    };
}

function testMessage(role: "user" | "assistant", text: string) {
    return {
        role,
        content: [{ type: "text" as const, text }],
        timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0];
}

async function isFile(path: string) {
    try {
        return (await Deno.stat(path)).isFile;
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }
        throw error;
    }
}
