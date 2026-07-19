import {
    ClientPresence,
    LOCAL_CLIENT_ID,
} from "../../src/runtime/client-presence.ts";
import { SessionControlConflictError } from "../../src/errors.ts";
import assert from "node:assert/strict";

/**
 * Purpose: Verify ClientPresence independently tracks per-client focus and
 * mutation ownership, then releases ownership without disturbing focus.
 * Expect: Focus is readable, an acquired lease has an owner, and release removes it.
 * Method: Focus LOCAL_CLIENT_ID on one session, acquire its control lease, assert
 * both lookup directions, release once, and confirm the owner entry is removed.
 */
Deno.test("ClientPresence tracks focus and control leases", () => {
    const presence = new ClientPresence();

    presence.focus(LOCAL_CLIENT_ID, "session-a");
    assert.equal(presence.activeFor(LOCAL_CLIENT_ID), "session-a");

    presence.acquireControl(LOCAL_CLIENT_ID, "session-a");
    assert.equal(presence.ownerOf("session-a"), LOCAL_CLIENT_ID);

    presence.releaseControl(LOCAL_CLIENT_ID, "session-a");
    assert.equal(presence.ownerOf("session-a"), undefined);
});

/**
 * Purpose: Verify one client can re-enter control of the same session safely.
 * Expect: The lease remains owned after one release and clears only after the
 * matching second release.
 * Method: Acquire session-a twice for client-a, release each hold in turn, and
 * inspect ownership after each release.
 */
Deno.test("ClientPresence balances re-entrant control for one owner", () => {
    const presence = new ClientPresence();

    presence.acquireControl("client-a", "session-a");
    presence.acquireControl("client-a", "session-a");
    assert.equal(presence.ownerOf("session-a"), "client-a");

    presence.releaseControl("client-a", "session-a");
    assert.equal(presence.ownerOf("session-a"), "client-a");

    presence.releaseControl("client-a", "session-a");
    assert.equal(presence.ownerOf("session-a"), undefined);
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

    assert.throws(
        () => presence.acquireControl("client-b", "session-a"),
        SessionControlConflictError,
    );
});

/**
 * Purpose: Verify new clients inherit a stable session focus without overwriting
 * the most recently focused session.
 * Expect: The first client uses its fallback; later clients inherit last-active.
 * Method: Attach with a fallback, change focus, then attach another client.
 */
Deno.test("ClientPresence attaches clients with fallback and last-active focus", () => {
    const presence = new ClientPresence();

    presence.attachClient("client-a", "session-a");
    assert.equal(presence.activeFor("client-a"), "session-a");

    presence.focus("client-a", "session-b");
    presence.attachClient("client-b", "session-a");
    assert.equal(presence.activeFor("client-b"), "session-b");
    assert.deepEqual(presence.clients(), ["client-a", "client-b"]);
});

/**
 * Purpose: Verify disconnect releases every lease owned by one client, including
 * re-entrant holds, without disturbing another client's control.
 * Expect: Changed session ids contain only the detached owner's sessions.
 * Method: Acquire three leases across two clients, detach one, and inspect state.
 */
Deno.test("ClientPresence detach releases all leases for one client", () => {
    const presence = new ClientPresence();
    presence.attachClient("client-a");
    presence.attachClient("client-b");
    presence.acquireControl("client-a", "session-a");
    presence.acquireControl("client-a", "session-a");
    presence.acquireControl("client-a", "session-b");
    presence.acquireControl("client-b", "session-c");

    assert.deepEqual(presence.detachClient("client-a"), [
        "session-a",
        "session-b",
    ]);
    assert.equal(presence.ownerOf("session-a"), undefined);
    assert.equal(presence.ownerOf("session-b"), undefined);
    assert.equal(presence.ownerOf("session-c"), "client-b");
    assert.deepEqual(presence.clients(), ["client-b"]);
});

/**
 * Purpose: Verify eviction removes every stale focus/control reference and
 * publishes the fallback as the new process-wide last-active session.
 * Expect: Affected clients move to fallback while unrelated focus remains intact.
 * Method: Focus two clients, remove the last-active controlled session, then attach another.
 */
Deno.test("ClientPresence removes stale session references with fallback", () => {
    const presence = new ClientPresence();
    presence.focus("client-b", "session-kept");
    presence.focus("client-a", "session-removed");
    presence.acquireControl("client-a", "session-removed");
    presence.acquireControl("client-b", "session-kept");

    presence.removeSession("session-removed", "session-fallback");

    assert.equal(presence.activeFor("client-a"), "session-fallback");
    assert.equal(presence.activeFor("client-b"), "session-kept");
    assert.equal(presence.ownerOf("session-removed"), undefined);

    presence.attachClient("client-c", "ignored-fallback");
    assert.equal(presence.activeFor("client-c"), "session-fallback");

    presence.releaseControl("client-a", "session-kept");
    assert.equal(presence.ownerOf("session-kept"), "client-b");
    presence.releaseControl("client-b", "session-kept");
    assert.equal(presence.ownerOf("session-kept"), undefined);
});
