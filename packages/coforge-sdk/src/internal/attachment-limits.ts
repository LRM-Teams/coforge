/**
 * The attachment size ceiling every hop enforces: the cloud rejects attachments above it, and the
 * daemon's local upload proxy allows it plus a small multipart-framing slack (boundary markers,
 * field headers) so a file the cloud accepts is never refused on the local hop.
 *
 * The daemon package cannot import from `apps/web`, and the web server cannot import the daemon,
 * so the base number lives here and both derive their own enforcement from it instead of keeping
 * two copies of "10 MiB" in step by hand.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
