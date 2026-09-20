import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("refreshes a selected Pi provider after installing its session API key", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-model-refresh-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const provider = new URL(request.url).pathname.split("/").at(-1);
      if (provider !== "anthropic") return new Response(null, { status: 404 });
      return Response.json(
        [
          {
            id: "remote-regression-model",
            name: "Remote Regression Model",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 8_192,
          },
        ],
        { headers: { "last-modified": "Fri, 01 Jan 2099 00:00:00 GMT" } },
      );
    },
  });
  await Bun.write(
    join(workspace, "catalog-preload.ts"),
    `const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "pi.dev") {
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = ${JSON.stringify(String(server.port))};
  }
  return nativeFetch(url, init);
};
`,
  );
  await Bun.write(
    join(workspace, "session.ts"),
    `import { createSession } from ${JSON.stringify(new URL("../src/runner.ts", import.meta.url).pathname)};
const created = await createSession({
  cwd: ${JSON.stringify(workspace)},
  agentDir: ${JSON.stringify(join(workspace, ".pi", "agent"))},
  sessionDir: ${JSON.stringify(join(workspace, ".pi-sessions"))},
  sessionKind: "pi",
  modelProvider: "anthropic",
  model: "remote-regression-model",
  apiKey: "managed-session-key",
  instructions: "Test only.",
  environment: { HOME: ${JSON.stringify(workspace)}, PATH: ${JSON.stringify(process.env.PATH ?? "")} },
});
await created.dispose();
`,
  );
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "--preload", join(workspace, "catalog-preload.ts"), "session.ts"],
      cwd: workspace,
      env: { HOME: workspace, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  } finally {
    server.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("loads workspace skills before accepting RPC commands", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-"));
  const skillDirectory = join(workspace, ".pi", "skills", "startup-proof");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---
name: startup-proof
description: Proves that skills are loaded before the Agent becomes ready.
---

Use this skill only for the startup test.
`,
  );

  const child = Bun.spawn({
    cmd: [process.execPath, new URL("../src/runner.ts", import.meta.url).pathname],
    cwd: workspace,
    env: {
      HOME: workspace,
      PATH: process.env.PATH ?? "",
      PI_OFFLINE: "1",
      COFORGE_AGENT_INSTRUCTIONS: "Use the CoForge CLI for communication.",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    child.stdin.write(`${JSON.stringify({ id: "skills", type: "get_commands" })}\n`);
    await child.stdin.flush();
    const response = await readResponse(child.stdout, "skills");
    const commands = (
      response.data as {
        commands: Array<{
          name: string;
          description?: string;
          source: string;
          sourceInfo: unknown;
        }>;
      }
    ).commands;
    expect(commands).toContainEqual({
      name: "skill:startup-proof",
      description: "Proves that skills are loaded before the Agent becomes ready.",
      source: "skill",
      sourceInfo: expect.any(Object),
    });
  } finally {
    child.stdin.end();
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!exited) child.kill("SIGTERM");
    await child.exited;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("does not become ready when a workspace skill is invalid", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-invalid-"));
  const skillDirectory = join(workspace, ".pi", "skills", "invalid");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "# Missing required frontmatter\n");
  const child = spawnRunner(workspace);

  try {
    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
    await child.stdin.flush();
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain('"id":"state"');
  } finally {
    child.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
  }
});

function spawnRunner(workspace: string): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, new URL("../src/runner.ts", import.meta.url).pathname],
    cwd: workspace,
    env: {
      HOME: workspace,
      PATH: process.env.PATH ?? "",
      PI_OFFLINE: "1",
      COFORGE_AGENT_INSTRUCTIONS: "Use the CoForge CLI for communication.",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readResponse(
  stdout: ReadableStream<Uint8Array>,
  id: string,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.id === id) return record;
      }
      newline = buffer.indexOf("\n");
    }
  }
  throw new Error("Agent process closed before responding");
}

test("a second Pi launch inside the throttle window does not re-fetch the catalog", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-agent-model-throttle-"));
  let catalogRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const provider = new URL(request.url).pathname.split("/").at(-1);
      if (provider !== "anthropic") return new Response(null, { status: 404 });
      catalogRequests += 1;
      return Response.json(
        [
          {
            id: "remote-throttle-model",
            name: "Remote Throttle Model",
            api: "anthropic-messages",
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 8_192,
          },
        ],
        { headers: { "last-modified": "Fri, 01 Jan 2099 00:00:00 GMT" } },
      );
    },
  });
  await Bun.write(
    join(workspace, "catalog-preload.ts"),
    `const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "pi.dev") {
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = ${JSON.stringify(String(server.port))};
  }
  return nativeFetch(url, init);
};
`,
  );
  await Bun.write(
    join(workspace, "session.ts"),
    `import { createSession } from ${JSON.stringify(new URL("../src/runner.ts", import.meta.url).pathname)};
const created = await createSession({
  cwd: ${JSON.stringify(workspace)},
  agentDir: ${JSON.stringify(join(workspace, ".pi", "agent"))},
  sessionDir: ${JSON.stringify(join(workspace, ".pi-sessions"))},
  sessionKind: "pi",
  modelProvider: "anthropic",
  model: "remote-throttle-model",
  apiKey: "managed-session-key",
  instructions: "Test only.",
  environment: { HOME: ${JSON.stringify(workspace)}, PATH: ${JSON.stringify(process.env.PATH ?? "")} },
});
await created.dispose();
`,
  );
  const runSession = async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "--preload", join(workspace, "catalog-preload.ts"), "session.ts"],
      cwd: workspace,
      env: { HOME: workspace, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  };
  try {
    await runSession();
    expect(catalogRequests).toBe(1);
    // The launch path must not force a refresh: the SDK's own interval keeps the second launch
    // from hitting the network again, so an offline or slow network cannot stall every start.
    await runSession();
    expect(catalogRequests).toBe(1);
  } finally {
    server.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
}, 40_000);
