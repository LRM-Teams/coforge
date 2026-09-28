/**
 * How many Activity frames are kept per Agent. The browser's Activity timeline
 * (`mergeAgentActivity`) and the server's history read (`AgentActivityRepository`) keep the same
 * number of frames, so both import this one value instead of each carrying its own copy that the
 * other had to be changed with.
 *
 * The browser and the server both reach it: the module carries no server-only imports.
 */
export const AGENT_ACTIVITY_WINDOW = 500;
