/**
 * The UTF-8 codec, shared instead of constructed per call.
 *
 * Both directions are per-call operations on a value: `encode` is stateless, and a `decode` without
 * `{ stream: true }` resets the decoder, so one instance each can serve every call site. They run
 * wherever text becomes bytes or bytes become text — every realtime event, every message payload,
 * every agent-environment read — which is often enough for the allocation to show: 300,000 decodes
 * of a small JSON payload cost 64.7ms when the decoder is constructed each time and 38.5ms when it
 * is shared (1.68x, measured on this repository's Bun 1.4.2).
 *
 * A decoder **streaming** a chunked response is the one thing that cannot share: `{ stream: true }`
 * carries state between calls, so those sites keep their own instance. Six files do that today —
 * the daemon's code-agent turn readers (cursor, grok, opencode, the JSONL reader) and the platform
 * process channel — and they are deliberately unchanged.
 */
export const utf8Encoder = new TextEncoder();

/** See `utf8Encoder`; safe because these calls are complete decodes, never streaming ones. */
export const utf8Decoder = new TextDecoder();
