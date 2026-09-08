import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "../src/code-agent/contract";
import { CoforgeDriver, PiDriver } from "../src/code-agent/pi/driver";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

test("external Pi resumes the cloud-selected ID and rejects a different returned session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-pi-resume-"));
  const history = join(workspace, ".pi-sessions", "timestamp_selected-session.jsonl");
  await mkdir(join(workspace, ".pi-sessions"));
  await Bun.write(
    history,
    JSON.stringify({ type: "session", id: "selected-session", cwd: workspace }),
  );
  const reports: Array<[string, string | undefined]> = [];
  const create = (extra: string[] = []) =>
    new PiDriver({
      command: [
        process.execPath,
        new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname,
        "expect-resume",
        ...extra,
      ],
    }).createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId: "selected-session",
      async onSessionId(id, replaced) {
        reports.push([id, replaced]);
      },
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
  const session = await create();
  await session.dispose();
  await expect(create(["wrong-session"])).rejects.toThrow(
    "Pi did not resume the requested workspace session",
  );
  await rm(history);
  const fresh = await create();
  await fresh.dispose();
  expect(reports.at(-1)?.[0]).not.toBe("selected-session");
  expect(reports.at(-1)?.[1]).toBe("selected-session");
  await rm(workspace, { recursive: true, force: true });
});

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

test("Pi loads skills before running in a child process behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-rpc-"));
  process.env.COFORGE_UNDECLARED_TEST_VALUE = "present";
  const adapter = new PiDriver({
    command: [
      process.execPath,
      new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname,
      "expected-agent-instructions",
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
      runtime: {
        provider: "pi",
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
        reasoning: "high",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([
      { type: "text-delta", text: "Pi response" },
      { type: "tool-start", id: "tool-1", name: "bash" },
      {
        type: "activity",
        activity: {
          detailKind: "running_command",
          level: "info",
          detail: "printf safe",
          observedAtMs: Date.parse("2024-12-03T14:02:47.890Z"),
          entries: [{ kind: "tool_start", toolName: "bash" }],
        },
      },
      { type: "tool-output", id: "tool-1", text: "tests passed" },
      { type: "tool-end", id: "tool-1", isError: false },
      { type: "completed", status: "completed" },
    ]);
    expect(events.filter((event) => event.type === "session")).toEqual([
      { type: "session", identity: { sessionId: "fixture-new", state: "unknown" } },
    ]);

    events.length = 0;
    await session.sendMessage("wait");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    unsubscribe();
    await session.dispose();
  } finally {
    delete process.env.COFORGE_UNDECLARED_TEST_VALUE;
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("an external Pi-compatible process completes the driver handshake", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-installed-"));
  try {
    const session = await new PiDriver({
      command: [process.execPath, new URL("../../agent/src/runner.ts", import.meta.url).pathname],
    }).createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("CoForge Agent requires a matching API key for a configured built-in provider", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-credential-"));
  const adapter = new CoforgeDriver();
  const runtime = {
    provider: "coforge" as const,
    model: "deepseek-chat",
    modelProvider: "deepseek",
    reasoning: "high",
    providerConfig: {
      kind: "coforge" as const,
      providerId: "deepseek",
    },
  };

  try {
    await expect(
      adapter.createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
        runtime,
      }),
    ).rejects.toThrow("CoForge runtime provider API key is required");
    await expect(
      adapter.createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
        runtime: {
          ...runtime,
          providerConfig: {
            ...runtime.providerConfig,
            providerId: "anthropic",
            apiKey: "sk-anthropic-secret",
          },
        },
      }),
    ).rejects.toThrow("does not match the selected model");
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Pi rejects overlapping prompts and dispose cannot wait on provider interrupt", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-lifecycle-"));
  const adapter = new PiDriver({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    await session.sendMessage("ignore-abort");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Pi accepts busy notifications without ending the existing run", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-notify-"));
  const adapter = new PiDriver({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.notify!("New message available. Run coforge message check.");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });

    await session.sendMessage("wait");
    events.length = 0;
    await expect(session.notify!("reject-notice")).rejects.toThrow("code agent request failed");
    await session.notify!("busy notice");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Pi rejects prompts after its resident Agent runtime process exits", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-exit-"));
  const adapter = new PiDriver({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: {
        COFORGE_DECLARED_TEST_VALUE: "allowed",
        COFORGE_EXIT_AFTER_READY: "1",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitForEvent(events, "activity");
    expect(events.at(-1)).toMatchObject({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "code agent process exited unexpectedly",
      },
    });
    await expect(session.sendMessage("after-exit")).rejects.toThrow("exited unexpectedly");
    await expect(session.sendMessage("still-exited")).rejects.toThrow("exited unexpectedly");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

async function waitForEvent(
  events: AgentRuntimeEvent[],
  type: AgentRuntimeEvent["type"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${type}`);
}
