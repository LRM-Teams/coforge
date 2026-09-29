import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tenantTokenForWorkspace } from "../../../apps/web/src/server/causal-memory/config.server";

const DEFAULT_BIN = "/home/zhoujie22/river2_0/causal-memory/target/debug/causal-memory";
const DEFAULT_DISTILL_KEY_FILE = new URL(
  "../../../infra/secrets/coforge_causal_memory_distill_model_api_key",
  import.meta.url,
).pathname;

export type CausalHost = {
  url: string;
  tokensPath: string;
  stop: () => Promise<void>;
};

export async function persistEvalTenantTokens(
  workspaceId: string,
  directory: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID().replaceAll("-", "");
  const tokensPath = join(directory, "tenant-tokens.json");
  await writeFile(tokensPath, `${JSON.stringify({ [token]: workspaceId })}\n`, { mode: 0o600 });
  return tokensPath;
}

export async function assertTenantTokenResolves(
  workspaceId: string,
  tokensPath: string,
): Promise<void> {
  const token = tenantTokenForWorkspace(workspaceId, workspaceId, {
    COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE: tokensPath,
  });
  if (!token) throw new Error("eval tenant token did not resolve");
}

async function waitReady(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const health = await fetch(new URL("/healthz", url));
      const ready = await fetch(new URL("/readyz", url));
      if (health.ok && ready.ok) return;
      last = `healthz ${health.status} readyz ${ready.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`causal-memory not ready at ${url}: ${last}`);
}

export async function startCausalHost(input: {
  workspaceId: string;
  url?: string;
  bin?: string;
  distillKeyFile?: string;
}): Promise<CausalHost> {
  const parsed = new URL(input.url ?? "http://127.0.0.1:9938");
  const configured = Bun.env.COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE;
  const directory = configured
    ? dirname(configured)
    : join(tmpdir(), `pcm-causal-${input.workspaceId.slice(0, 8)}`);
  const tokensPath = await persistEvalTenantTokens(input.workspaceId, directory);
  await assertTenantTokenResolves(input.workspaceId, tokensPath);
  Bun.env.COFORGE_CAUSAL_MEMORY_URL = parsed.origin;
  Bun.env.COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE = tokensPath;

  const bin = input.bin ?? Bun.env.COFORGE_EVAL_CAUSAL_BIN ?? DEFAULT_BIN;
  const dbPath = join(directory, "causal-memory.sqlite");
  const proc = Bun.spawn([bin, "http", "--host", parsed.hostname, "--port", parsed.port || "9938"], {
    cwd: directory,
    env: {
      ...process.env,
      CAUSAL_MEMORY_DB: dbPath,
      CAUSAL_MEMORY_TOKENS_FILE: tokensPath,
      CAUSAL_MEMORY_DISTILL_MODEL_API_KEY_FILE:
        input.distillKeyFile ??
        Bun.env.CAUSAL_MEMORY_DISTILL_MODEL_API_KEY_FILE ??
        DEFAULT_DISTILL_KEY_FILE,
      CAUSAL_MEMORY_ALLOWED_HOSTS: "localhost,127.0.0.1,::1",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitReady(parsed.origin);
  } catch (error) {
    proc.kill();
    throw error;
  }
  return {
    url: parsed.origin,
    tokensPath,
    async stop() {
      proc.kill();
      await proc.exited.catch(() => undefined);
    },
  };
}
