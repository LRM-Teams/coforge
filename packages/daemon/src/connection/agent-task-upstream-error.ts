/**
 * An upstream Task refusal whose cause is kept for the daemon's own log, never for the caller: the
 * caller already gets an opaque message plus the correlation id, and an upstream's internals are not
 * this API's to publish (see `agent-proxy-failure.ts`).
 *
 * Its own module, like its siblings, so a consumer of the failure classifier does not pull in the
 * whole connection stack — the macOS lifecycle fixture asserts the daemon's provider graph still
 * links, and an import from `daemon-connection` here was a cycle.
 */
export class AgentTaskUpstreamError extends Error {
  constructor(
    message: string,
    /** The `code` the server's JSON error body carried, when it carried one. */
    readonly upstreamCode?: string,
  ) {
    super(message);
    this.name = "AgentTaskUpstreamError";
  }
}
