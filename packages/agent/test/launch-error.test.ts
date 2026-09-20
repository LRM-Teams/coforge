import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a small session script against a local models.json (offline) and returns
 * the classified outcome. Every path lives inside one fixture workspace so the
 * session resolves the exact catalog we wrote.
 */
async function runSessionFixture(
  modelsJson: object,
  modelProvider: string | undefined,
  model: string | undefined,
): Promise<{ code: number; stderr: string; json?: Record<string, unknown> }> {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-launch-error-"));
  const agentDir = join(workspace, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(workspace, "session.ts"),
    `import { createSession } from ${JSON.stringify(
      new URL("../src/runner.ts", import.meta.url).pathname,
    )};
const result = await (async () => {
  try {
    await createSession({
      cwd: ${JSON.stringify(workspace)},
      agentDir: ${JSON.stringify(agentDir)},
      sessionDir: ${JSON.stringify(`${workspace}/.pi-sessions`)},
      sessionKind: "pi",
      instructions: "Test only.",
      environment: { HOME: ${JSON.stringify(workspace)}, PATH: ${JSON.stringify(process.env.PATH ?? "")} },
      ${modelProvider ? `modelProvider: ${JSON.stringify(modelProvider)},` : ""}
      ${model ? `model: ${JSON.stringify(model)},` : ""}
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      name: error?.name ?? "unknown",
      policyCode: error?.policyCode ?? null,
      trace: error?.trace ?? null,
    };
  }
})();
console.log(JSON.stringify(result));
`,
  );
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "session.ts"],
      cwd: workspace,
      env: { HOME: workspace, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exit = await child.exited;
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      /* leave undefined for assertion output below */
    }
    return { code: exit, stderr, json };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const OLLAMA_CATALOG = {
  providers: {
    "ollama-cloud": {
      baseUrl: "https://ollama.com/v1",
      api: "openai-completions",
      apiKey: "test-key",
      models: [
        {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 262144,
          maxTokens: 65536,
          cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
        },
      ],
    },
  },
};

test("a requested model absent from the local catalog is classified as model_missing", async () => {
  const { code, stderr, json } = await runSessionFixture(
    OLLAMA_CATALOG,
    "ollama-cloud",
    "does-not-exist-xyz",
  );
  expect(code, stderr).toBe(0);
  expect(json?.ok).toBe(false);
  expect(json?.name).toBe("PiLaunchError");
  expect(json?.policyCode).toBe("PI_LAUNCH_MODEL_MISSING");
  const trace = json?.trace as Record<string, unknown>;
  expect(trace?.provider).toBe("ollama-cloud");
  expect(trace?.providerPresent).toBe(true);
  expect(trace?.providerKeyPresent).toBe(true);
  expect(trace?.baseUrlPresent).toBe(true);
  expect(trace?.modelPresent).toBe(false);
});

test("an unconfigured provider is classified as provider_missing", async () => {
  const { code, stderr, json } = await runSessionFixture(
    OLLAMA_CATALOG,
    "no-such-provider",
    "glm-5.3-flash",
  );
  expect(code, stderr).toBe(0);
  expect(json?.ok).toBe(false);
  expect(json?.name).toBe("PiLaunchError");
  expect(json?.policyCode).toBe("PI_LAUNCH_PROVIDER_MISSING");
  const trace = json?.trace as Record<string, unknown>;
  expect(trace?.provider).toBe("no-such-provider");
  expect(trace?.providerPresent).toBe(false);
});
