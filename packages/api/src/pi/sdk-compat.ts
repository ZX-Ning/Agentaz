/**
 * Pi SDK 0.80.6 has no compact-unavailable error class/code. Observed behavior:
 *   - too-small session -> Error("Nothing to compact (session too small)")
 *   - unchanged leaf -> Error("Already compacted")
 * Keep the exact-message dependency isolated and revalidate it on SDK upgrade.
 * Related upstream compaction tracker (not a typed-error request):
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
