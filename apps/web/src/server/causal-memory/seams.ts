/**
 * W0.3 test seams. Implementation and scenario tests attach here; no UI tests.
 *
 * 1. Extension HTTP contract — `contract.ts` routes/types under `/coforge/v1`.
 * 2. Web CausalMemory module — `CausalMemoryModule` in `contract.ts`.
 * 3. Agent local proxy contract — SDK `CAUSAL_AGENT_PROTOCOL` + `/api/agent/v1/causal`.
 * 4. Public-channel scenario — Workspace isolation, admission, read, Offer, correction.
 */
export const CAUSAL_MEMORY_TEST_SEAMS = [
  "extension-http",
  "web-causal-memory-module",
  "agent-local-proxy",
  "public-channel-scenario",
] as const;

export type CausalMemoryTestSeam = (typeof CAUSAL_MEMORY_TEST_SEAMS)[number];
