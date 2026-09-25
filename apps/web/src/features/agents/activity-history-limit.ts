/**
 * How many activity frames per Agent each side keeps: the server repository caps its history
 * reads at this, and the browser keeps up to this many frames per Agent when merging, so the
 * two caps are one fact.
 *
 * The server side lives in `server/db/repositories/agent-activity.repositories.server.ts`,
 * which the browser cannot import; this neutral, dependency-free module is what lets the
 * repository and the browser share the number instead of keeping two copies in step by hand
 * (both `AGENTS.md` files had to say "change them together").
 */
export const ACTIVITY_HISTORY_LIMIT = 500;
