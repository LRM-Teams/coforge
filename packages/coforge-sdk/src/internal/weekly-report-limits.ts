/**
 * The Markdown a weekly-report Agent exchange may carry, in either direction over the Agent HTTP
 * API. Two payloads are both this document and this one budget: the collect pack the daemon sends
 * (`packMarkdown`) and the report Markdown an Agent sends for key-point extraction (`markdown`).
 *
 * Five places have to agree about it, which is why it is stated once here: the two web route
 * schemas, the daemon's two payload validators, and the daemon proxy's body cap. Before this,
 * `agent-proxy.ts` carried a comment saying its cap "matches apps/web weekly-report-collect
 * packMarkdown max (500_000) plus JSON framing" — the coupling was real, and only the comment held
 * it.
 *
 * The proxy's cap is deliberately *not* this constant and not derived from it: it is a byte budget
 * (512 KiB) for a JSON body, so it has to cover these characters *plus* framing, and for text that
 * is not ASCII the byte budget binds before the character cap does. Naming that rather than
 * equating the two keeps the units honest; changing it is a decision about the API's real limit.
 */
export const WEEKLY_REPORT_MARKDOWN_MAX_CHARS = 500_000;
