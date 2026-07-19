/**
 * Pi SDK 0.80.6 throws plain Error values for unavailable manual compaction.
 * Keep the exact-message dependency isolated here until upstream exposes a
 * typed error. Related upstream compaction tracker:
 * https://github.com/earendil-works/pi/issues/128
 */
const COMPACT_UNAVAILABLE_MESSAGES = new Set([
    "Nothing to compact (session too small)",
    "Already compacted",
]);

/** Returns the pinned SDK message only for known compact-unavailable errors. */
export function compactUnavailableMessage(error: unknown) {
    if (
        error instanceof Error &&
        COMPACT_UNAVAILABLE_MESSAGES.has(error.message)
    ) {
        return error.message;
    }
    return undefined;
}
