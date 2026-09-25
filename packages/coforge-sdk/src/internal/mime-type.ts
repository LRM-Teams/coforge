/**
 * RFC 6838 `type/subtype`, case-insensitively. The Agent CLI validates a `--mime-type` against it
 * before an upload, and the Agent HTTP attachment routes validate the content type they receive,
 * so both ends must agree on the same shape. It lives here because neither the CLI package nor
 * `apps/web` can import the other.
 */
export const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
