import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantTokenForWorkspace } from "../../../apps/web/src/server/causal-memory/config.server";
import { persistEvalTenantTokens } from "../src/causal-host";

test("eval tenant tokens map a disposable workspace id without using the docker secret", async () => {
  const workspaceId = crypto.randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "pcm-tokens-"));
  const tokensPath = await persistEvalTenantTokens(workspaceId, directory);
  const token = tenantTokenForWorkspace(workspaceId, workspaceId, {
    COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE: tokensPath,
  });
  expect(token.length).toBeGreaterThan(8);
  expect(token).not.toBe(workspaceId);
});
