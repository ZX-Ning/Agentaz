import {
    ClientPresence,
    LOCAL_CLIENT_ID,
} from "../src/runtime/client-presence.ts";
import { SessionControlConflictError } from "../src/errors.ts";

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

Deno.test("ClientPresence rejects conflicting control owners", () => {
    const presence = new ClientPresence();

    presence.acquireControl("client-a", "session-a");

    try {
        presence.acquireControl("client-b", "session-a");
    } catch (error) {
        if (error instanceof SessionControlConflictError) return;
        throw error;
    }

    throw new Error("expected conflicting control owner to throw");
});
