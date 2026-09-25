/**
 * How long a liveness probe waits for the daemon's reply before the Agent activity sweep
 * synthesises `online`, and how far the browser pushes a busy Agent's status deadline out — the
 * two must agree, so both sides import this one value.
 *
 * The sweep lives in `server/agents/agent-activity-sweep.server.ts`, which the browser cannot
 * import; this neutral, dependency-free module is what lets the browser and the server share the
 * number instead of each keeping its own copy in step by hand.
 */
export const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
