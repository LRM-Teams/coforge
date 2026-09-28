/**
 * CoForge's UUID: the RFC 9562 shape with its version and variant nibbles checked — a `1`-`8`
 * version digit and the `8`/`9`/`a`/`b` variant — rather than four unspecified groups of hex.
 *
 * The one definition, because a dozen decoders and key matchers ask the same question about ids
 * CoForge itself mints: the SDK's reminder-id and weekly-report wire checks, the daemon's app-inbox
 * source refs, collect/KeyPoint commands, upgrade launcher and upgrade-job sweep, the Web app's
 * weekly-report session subject and notification target, the Computer's upgrade request, and the
 * CLI's report collector.
 *
 * `RFC_UUID_SOURCE` is the unanchored source for the places that need the shape *inside* a larger
 * pattern; everything else uses the anchored `RFC_UUID_PATTERN`.
 *
 * Not the same question as the permissive four-hex-group checks a few wire paths make — "is this
 * value shaped like a UUID", whatever minted it. Those deliberately looser checks share this
 * module's `UUID_LIKE_SOURCE`; their anchoring, casing and flags stay each caller's.
 */
export const RFC_UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const RFC_UUID_PATTERN = new RegExp(`^${RFC_UUID_SOURCE}$`, "i");

/** The permissive shape: four groups of hex — "is this value shaped like a UUID", whatever minted
 * it. Ids CoForge itself mints satisfy the RFC rule above; these looser checks accept ids from
 * earlier versions or foreign minting that happen to be shaped like a UUID. Anchoring, casing and
 * flags stay the caller's: some sites need the source inside a larger pattern. */
export const UUID_LIKE_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The permissive shape anchored and case-insensitive, for the sites that would otherwise write
 * `new RegExp("^${UUID_LIKE_SOURCE}$", "i")` identically; sites needing another anchoring, casing
 * or embedding use `UUID_LIKE_SOURCE` and build their own. */
export const UUID_LIKE_PATTERN = new RegExp(`^${UUID_LIKE_SOURCE}$`, "i");
