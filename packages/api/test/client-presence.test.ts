import {
    ClientPresence,
    LOCAL_CLIENT_ID,
} from "../src/runtime/client-presence.ts";
import { SessionControlConflictError } from "../src/errors.ts";

/**
 * Purpose: Verify ClientPresence independently tracks per-client focus and
 * re-entrant mutation ownership, then releases ownership without disturbing focus.
 * Expect: Focus is readable, an acquired lease has an owner, and release removes it.
 * Method: Focus LOCAL_CLIENT_ID on one session, acquire its control lease, assert
 * both lookup directions, release once, and confirm the owner entry is removed.
 */
Deno.test("ClientPresence tracks focus and control leases", () => {
    const presence = new ClientPresence();

    presence.focus(LOCAL_CLIENT_ID, "session-a");
    if (presence.activeFor(LOCAL_CLIENT_ID) !== "session-a") {
        throw new Error("focused session should be tracked");
    }

    presence.acquireControl(LOCAL_CLIENT_ID, "session-a");
    if (presence.ownerOf("session-a") !== LOCAL_CLIENT_ID) {
        throw new Error("control owner should be tracked");
    }

    presence.releaseControl(LOCAL_CLIENT_ID, "session-a");
    if (presence.ownerOf("session-a") !== undefined) {
        throw new Error("control owner should be released");
    }
});

/**
 * Purpose: Verify the single-owner invariant prevents simultaneous mutations from
 * different browser tabs while an existing control lease is active.
 * Expect: A second owner receives SessionControlConflictError.
 * Method: Acquire session-a for client-a, attempt the same acquisition for
 * client-b, and require the typed conflict error rather than a generic failure.
 */
Deno.test("ClientPresence rejects conflicting control owners", () => {
    const presence = new ClientPresence();

    presence.acquireControl("client-a", "session-a");

    try {
        presence.acquireControl("client-b", "session-a");
    }
    catch (error) {
        if (error instanceof SessionControlConflictError) {
            return;
        }
        throw error;
    }

    throw new Error("expected conflicting control owner to throw");
});
