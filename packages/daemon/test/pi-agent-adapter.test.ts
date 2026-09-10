import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPiModels } from "@coforge/agent";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";
import { CoforgeDriver, PiDriver } from "../src/code-agent/pi/driver";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

test("Pi resolves native provider environment auth below stored auth and Agent keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-env-auth-"));
  const agentDir = join(root, "host-config");
  const oldKey = Bun.env.OPENAI_API_KEY;
  const keys: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      keys.push(request.headers.get("authorization"));
      return completionStream({ role: "assistant", content: "ok" }, "stop");
    },
  });
  try {
    await writeOpenAiHost(agentDir, `${server.url}v1`);
    await rm(join(agentDir, "auth.json"));
    Bun.env.OPENAI_API_KEY = "native-host-key";
    const catalog = await discoverPiModels(root, { agentDir });
    expect(catalog.some((model) => model.provider === "openai" && model.id === "custom")).toBe(
      true,
    );
    for (const mode of ["host", "declared", "stored", "agent"] as const) {
      const workspace = join(root, mode);
      await mkdir(workspace);
      if (mode === "stored")
        await Bun.write(
          join(agentDir, "auth.json"),
          JSON.stringify({ openai: { type: "api_key", key: "stored-key" } }),
        );
      const session = await new PiDriver().createAgentSession({
        agentWorkspaceDirectory: workspace,
        instructions: TEST_AGENT_INSTRUCTIONS,
        environment: {
          PI_CODING_AGENT_DIR: agentDir,
          ...(mode === "host" ? {} : { OPENAI_API_KEY: "declared-key" }),
        },
        runtime: {
          provider: "pi",
          modelProvider: "openai",
          model: "custom",
          reasoning: "",
          ...(mode === "agent"
            ? {
                providerConfig: {
                  kind: "coforge",
                  providerId: "openai",
                  apiKey: "agent-key",
                } as const,
              }
            : {}),
        },
      });
      try {
        await session.sendMessage(mode);
      } finally {
        await session.dispose();
      }
      expect(Bun.env.OPENAI_API_KEY).toBe("native-host-key");
    }
    expect(keys).toEqual([
      "Bearer native-host-key",
      "Bearer declared-key",
      "Bearer stored-key",
      "Bearer agent-key",
    ]);
  } finally {
    if (oldKey === undefined) delete Bun.env.OPENAI_API_KEY;
    else Bun.env.OPENAI_API_KEY = oldKey;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

function completionStream(delta: Record<string, unknown>, finishReason: string | null) {
  return new Response(
    [
      `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function writeOpenAiHost(agentDir: string, baseUrl: string) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: "host-key" }));
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl,
          models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
        },
      },
    }),
  );
}

function piRuntime(agentDir: string) {
  return {
    environment: { PI_CODING_AGENT_DIR: agentDir },
    runtime: {
      provider: "pi" as const,
      modelProvider: "openai",
      model: "custom",
      reasoning: "",
      providerConfig: { kind: "coforge" as const, providerId: "openai", apiKey: "agent-key" },
    },
  };
}

test("CoForge retains its isolated resources and required managed key", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-builtin-"));
  try {
    await expect(
      new CoforgeDriver().createAgentSession({
        agentWorkspaceDirectory: workspace,
        instructions: TEST_AGENT_INSTRUCTIONS,
        runtime: {
          provider: "coforge",
          modelProvider: "deepseek",
          model: "deepseek-chat",
          reasoning: "",
          providerConfig: { kind: "coforge", providerId: "deepseek" },
        },
      }),
    ).rejects.toThrow("CoForge runtime provider API key is required");
    expect((await readdir(workspace)).includes(".pi-sessions")).toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("embedded Pi uses host models and resources while an Agent key overrides host auth in memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-sdk-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workspace);
  const requests: Array<{ authorization: string | null; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return new Response(
        [
          `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const authPath = join(agentDir, "auth.json");
  await Bun.write(
    authPath,
    JSON.stringify({ openai: { type: "api_key", key: "host-secret-key" } }),
  );
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `${server.url}v1`,
          models: [{ id: "host-custom", name: "Host Custom", api: "openai-completions" }],
        },
      },
    }),
  );
  await Bun.write(
    join(agentDir, "extensions", "host-extension.ts"),
    `export default function (pi) { pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\\nHOST_EXTENSION_ACTIVE" })); }`,
  );
  const originalAuth = await Bun.file(authPath).text();
  const sessionIds: string[] = [];
  const session = await new PiDriver().createAgentSession({
    agentWorkspaceDirectory: workspace,
    agentId: "real-agent-id",
    instructions: TEST_AGENT_INSTRUCTIONS,
    environment: { PI_CODING_AGENT_DIR: agentDir },
    async onSessionId(id) {
      sessionIds.push(id);
    },
    runtime: {
      provider: "pi",
      modelProvider: "openai",
      model: "host-custom",
      reasoning: "",
      providerConfig: { kind: "coforge", providerId: "openai", apiKey: "agent-secret-key" },
    },
  });
  try {
    await session.sendMessage("hello");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer agent-secret-key");
    expect(requests[0]?.body).toContain("HOST_EXTENSION_ACTIVE");
    expect(await Bun.file(authPath).text()).toBe(originalAuth);
    expect((await readdir(workspace)).some((name) => name.startsWith(".pi-runtime-"))).toBe(false);
    for await (const path of new Bun.Glob("**/*").scan({ cwd: workspace, dot: true }))
      expect(await Bun.file(join(workspace, path)).text()).not.toContain("agent-secret-key");
    await session.dispose();
    const fresh = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      agentId: "real-agent-id",
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: agentDir },
      async onSessionId(id) {
        sessionIds.push(id);
      },
      runtime: {
        provider: "pi",
        modelProvider: "openai",
        model: "host-custom",
        reasoning: "",
        providerConfig: { kind: "coforge", providerId: "openai", apiKey: "agent-secret-key" },
      },
    });
    try {
      await fresh.sendMessage("second fresh turn");
      expect(sessionIds).toHaveLength(2);
      expect(sessionIds[1]).not.toBe(sessionIds[0]);
      expect(requests[1]?.body).not.toContain("hello");
    } finally {
      await fresh.dispose();
    }
  } finally {
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent embedded Pi sessions keep distinct in-memory Agent keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-concurrent-"));
  const agentDir = join(root, "host-pi-agent");
  await mkdir(agentDir, { recursive: true });
  const keys: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      keys.push(request.headers.get("authorization") ?? "");
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await Bun.write(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "host-key" } }),
  );
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `${server.url}v1`,
          models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
        },
      },
    }),
  );
  const create = async (name: string, apiKey?: string) => {
    const workspace = join(root, name);
    await mkdir(workspace);
    return new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: agentDir },
      runtime: {
        provider: "pi",
        modelProvider: "openai",
        model: "custom",
        reasoning: "",
        providerConfig: { kind: "coforge", providerId: "openai", ...(apiKey ? { apiKey } : {}) },
      },
    });
  };
  const sessions = await Promise.all([
    create("one", "agent-one-key"),
    create("two", "agent-two-key"),
    create("host"),
  ]);
  try {
    await Promise.all(sessions.map((session) => session.sendMessage("hello")));
    expect(new Set(keys)).toEqual(
      new Set(["Bearer agent-one-key", "Bearer agent-two-key", "Bearer host-key"]),
    );
  } finally {
    await Promise.all(sessions.map((session) => session.dispose()));
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi default bash preserves host prefix and composes runtime and host environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-bash-env-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  process.env.COFORGE_UNDECLARED_DAEMON_SENTINEL = "must-not-leak";
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requestCount += 1;
      if (requestCount === 1)
        return completionStream(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "bash-env",
                type: "function",
                function: {
                  name: "bash",
                  arguments:
                    '{"command":"printf \'prefix=%s declared=%s runtime=%s inherited=%s\' \\"$COFORGE_PREFIX_SENTINEL\\" \\"$COFORGE_DECLARED_SENTINEL\\" \\"$COFORGE_RUNTIME_SENTINEL\\" \\"$COFORGE_UNDECLARED_DAEMON_SENTINEL\\""}',
                },
              },
            ],
          },
          "tool_calls",
        );
      return completionStream({ role: "assistant", content: "done" }, "stop");
    },
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  await Bun.write(
    join(agentDir, "settings.json"),
    JSON.stringify({ shellCommandPrefix: "export COFORGE_PREFIX_SENTINEL=host-prefix" }),
  );
  const events: AgentRuntimeEvent[] = [];
  const session = await new PiDriver().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
    environment: {
      PI_CODING_AGENT_DIR: agentDir,
      COFORGE_DECLARED_SENTINEL: "declared-value",
    },
    runtime: {
      ...piRuntime(agentDir).runtime,
      envVars: { COFORGE_RUNTIME_SENTINEL: "runtime-value" },
    },
  });
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("inspect the environment");
    expect(events.filter((event) => event.type === "tool-output")).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "prefix=host-prefix declared=declared-value runtime=runtime-value inherited=must-not-leak",
        ),
      }),
    ]);
  } finally {
    delete process.env.COFORGE_UNDECLARED_DAEMON_SENTINEL;
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi keeps a host extension bash override instead of installing default bash", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-host-bash-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  let requestCount = 0;
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.text());
      requestCount += 1;
      if (requestCount === 1)
        return completionStream(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "host-bash",
                type: "function",
                function: { name: "bash", arguments: '{"command":"ignored"}' },
              },
            ],
          },
          "tool_calls",
        );
      return completionStream({ role: "assistant", content: "done" }, "stop");
    },
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  await Bun.write(
    join(agentDir, "extensions", "bash.ts"),
    `import { Type } from "@earendil-works/pi-ai";
export default function (pi) { pi.registerTool({ name: "bash", label: "Host bash", description: "host override", parameters: Type.Object({ command: Type.String() }), async execute() { return { content: [{ type: "text", text: "HOST_BASH_SENTINEL" }], details: {} }; } }); }`,
  );
  const session = await new PiDriver().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
  });
  try {
    await session.sendMessage("use bash");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("HOST_BASH_SENTINEL");
  } finally {
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi launches despite a duplicate host skill warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-skill-warning-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  const server = Bun.serve({
    port: 0,
    fetch: () => completionStream({ role: "assistant", content: "launched" }, "stop"),
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  for (const directory of ["one", "two"]) {
    await mkdir(join(agentDir, "skills", directory), { recursive: true });
    await Bun.write(
      join(agentDir, "skills", directory, "SKILL.md"),
      "---\nname: duplicate-host-skill\ndescription: duplicate warning fixture\n---\nInstructions.\n",
    );
  }
  const session = await new PiDriver().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
  });
  try {
    await session.sendMessage("launch");
  } finally {
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ["tool", "preflight"] as const) {
  test(`embedded Pi disposal waits for pending extension ${phase}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-pi-pending-tool-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "host-pi-agent");
    await mkdir(workspace);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const barrier = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/wait") {
          entered.resolve();
          await release.promise;
          return new Response("released");
        }
        if (path === "/entered") {
          await entered.promise;
          return new Response("entered");
        }
        return new Response("probe");
      },
    });
    const requests: string[] = [];
    const completion = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push(await request.text());
        if (requests.length === 1)
          return completionStream(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "pending-tool",
                  type: "function",
                  function: { name: "controlled", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
        return completionStream({ role: "assistant", content: "done" }, "stop");
      },
    });
    await writeOpenAiHost(agentDir, `${completion.url}v1`);
    await Bun.write(
      join(agentDir, "extensions", "controlled.ts"),
      phase === "preflight"
        ? `export default function (pi) { pi.on("before_agent_start", async () => { await fetch(${JSON.stringify(`${barrier.url}wait`)}); }); }`
        : `import { Type } from "@earendil-works/pi-ai";
export default function (pi) { pi.registerTool({ name: "controlled", label: "Controlled", description: "controlled barrier", parameters: Type.Object({}), async execute() { await fetch(${JSON.stringify(`${barrier.url}wait`)}); return { content: [{ type: "text", text: "released" }], details: {} }; } }); }`,
    );
    const session = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      ...piRuntime(agentDir),
    });
    let disposed = false;
    try {
      const input =
        phase === "preflight"
          ? session.notify!("run controlled hook")
          : session.sendMessage("run controlled tool");
      await fetch(`${barrier.url}entered`);
      if (phase === "tool") await session.notify!("QUEUED_NOTICE_MUST_NOT_RUN");
      const interrupting = session.interrupt();
      const disposing = session.dispose().then(() => {
        disposed = true;
      });
      await fetch(`${barrier.url}probe`);
      expect(disposed).toBe(false);
      release.resolve();
      await Promise.all([input, interrupting, disposing]);
      expect(requests).toHaveLength(phase === "tool" ? 1 : 0);
      expect(requests.join()).not.toContain("QUEUED_NOTICE_MUST_NOT_RUN");
    } finally {
      release.resolve();
      await session.dispose();
      completion.stop(true);
      barrier.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("built-in notifications are accepted before completion and steer the existing session", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-builtin-notify-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.text());
      started.resolve();
      await release.promise;
      return new Response(
        [
          `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await mkdir(join(agentWorkspaceDirectory, ".builtin-runtime"));
  await Bun.write(
    join(agentWorkspaceDirectory, ".builtin-runtime/models.json"),
    JSON.stringify({
      providers: { openrouter: { baseUrl: `${server.url}v1` } },
    }),
  );
  const session = await new CoforgeDriver().createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
    runtime: {
      provider: "coforge",
      modelProvider: "openrouter",
      model: "deepseek/deepseek-v4-flash-0731",
      reasoning: "",
      providerConfig: {
        kind: "coforge",
        providerId: "openrouter",
        apiKey: "fixture-test-key",
      },
    },
  });
  const events: AgentRuntimeEvent[] = [];
  const completed = Promise.withResolvers<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "completed") completed.resolve();
  });
  try {
    const first = session.notify!("initial notice");
    await started.promise;
    await first;
    await expect(session.sendMessage("overlap")).rejects.toThrow("cannot accept a new message");
    await session.notify!("busy notice");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    release.resolve();
    await completed.promise;
    expect(requests).toHaveLength(2);
    const providerRequest = JSON.parse(requests[0]!) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const instructionMessages = providerRequest.messages?.filter(
      (message) =>
        (message.role === "system" || message.role === "developer") &&
        typeof message.content === "string" &&
        message.content.includes(TEST_AGENT_INSTRUCTIONS),
    );
    expect(instructionMessages).toHaveLength(1);
    const instructionContent = instructionMessages?.[0]?.content;
    if (typeof instructionContent !== "string") throw new Error("missing native instructions");
    expect(instructionContent.split(TEST_AGENT_INSTRUCTIONS)).toHaveLength(2);
    expect(requests[1]).toContain("initial notice");
    expect(requests[1]).toContain("busy notice");
  } finally {
    release.resolve();
    await session.dispose();
    server.stop(true);
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("embedded Pi notifications are accepted before completion and steer the existing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-notify-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.text());
      started.resolve();
      await release.promise;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: "host-key" }));
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `${server.url}v1`,
          models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
        },
      },
    }),
  );
  const session = await new PiDriver().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    environment: { PI_CODING_AGENT_DIR: agentDir },
    runtime: {
      provider: "pi",
      modelProvider: "openai",
      model: "custom",
      reasoning: "",
      providerConfig: { kind: "coforge", providerId: "openai", apiKey: "agent-key" },
    },
  });
  const events: AgentRuntimeEvent[] = [];
  const completed = Promise.withResolvers<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "completed") completed.resolve();
  });
  try {
    const first = session.notify!("initial notice");
    await started.promise;
    await first;
    await expect(session.sendMessage("overlap")).rejects.toThrow("cannot accept a new message");
    await session.notify!("busy notice");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    release.resolve();
    await completed.promise;
    expect(requests).toHaveLength(2);
    const providerRequest = JSON.parse(requests[0]!) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const instructions = providerRequest.messages?.filter(
      (message) =>
        (message.role === "system" || message.role === "developer") &&
        typeof message.content === "string" &&
        message.content.includes(TEST_AGENT_INSTRUCTIONS),
    );
    expect(instructions).toHaveLength(1);
    const instructionContent = instructions?.[0]?.content;
    if (typeof instructionContent !== "string") throw new Error("missing native instructions");
    expect(instructionContent.split(TEST_AGENT_INSTRUCTIONS)).toHaveLength(2);
    expect(requests[1]).toContain("initial notice");
    expect(requests[1]).toContain("busy notice");
    await session.interrupt();
  } finally {
    release.resolve();
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
