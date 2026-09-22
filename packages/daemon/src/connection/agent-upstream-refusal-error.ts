/**
 * An upstream Agent-route refusal whose cause is kept for the daemon's own log, never for the
 * caller: the caller already gets an opaque message plus the correlation id, and an upstream's
 * internals are not this API's to publish (see `agent-proxy-failure.ts`). It carries the `code` the
 * server's JSON error body named — for the Task route and the reminder route alike, since both
 * answer a refusal with one.
 *
 * Its own module, like its siblings, so a consumer of the failure classifier does not pull in the
 * whole connection stack — the macOS lifecycle fixture asserts the daemon's provider graph still
 * links, and an import from `daemon-connection` here was a cycle.
 */
export class AgentUpstreamRefusalError extends Error {
  constructor(
    message: string,
    /** The `code` the server's JSON error body carried, when it carried one. */
    readonly upstreamCode?: string,
    /** The HTTP status the server answered with — what lets the local proxy hand a business
     * refusal (a 403/404/409) to the caller as that status instead of an opaque 502. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "AgentUpstreamRefusalError";
  }
}
