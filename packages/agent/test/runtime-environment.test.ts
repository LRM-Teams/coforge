import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/runner";

test("registered SDK Bash retains current session metadata and never revives stale control fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-bash-env-"));
  const previousSocket = Bun.env.COFORGE_SUPERVISOR_SOCKET;
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    Bun.env.COFORGE_SUPERVISOR_SOCKET = "/tmp/stale-supervisor.sock";
    created = await createSession({
      cwd: root,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionMode: "create",
      apiKey: "local-test-key",
      modelProvider: "openrouter",
      model: "openai/gpt-4o-mini",
      instructions: "Test only.",
      environment: {
        COFORGE_AGENT_CONTEXT: "current-context",
        COFORGE_AGENT_PROXY_URL: "http://current-proxy.invalid",
        COFORGE_DAEMON_SOCKET: "/tmp/current-daemon.sock",
        COFORGE_TEST_RUNTIME_VALUE: "agent-override",
        PI_SESSION_ID: "stale-session",
        PI_SESSION_FILE: "/tmp/stale-session.jsonl",
        PI_PROVIDER: "stale-provider",
        PI_MODEL: "stale-model",
        PI_REASONING_LEVEL: "stale-reasoning",
      },
    });
    const { session } = created;
    const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
    if (!bash) throw new Error("registered Bash missing");
    const result = await bash.execute("env-probe", {
      command: `printf '%s\\n' "$COFORGE_SUPERVISOR_SOCKET" "$COFORGE_AGENT_CONTEXT" "$COFORGE_AGENT_PROXY_URL" "$COFORGE_DAEMON_SOCKET" "$COFORGE_TEST_RUNTIME_VALUE" "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL" "$PWD"`,
    });
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toBe(
      [
        "",
        "current-context",
        "http://current-proxy.invalid",
        "/tmp/current-daemon.sock",
        "agent-override",
        "11111111-1111-4111-8111-111111111111",
        session.sessionManager.getSessionFile() ?? "",
        "openrouter",
        "openai/gpt-4o-mini",
        "off",
        root,
        "",
      ].join("\n"),
    );
    if (!session.model) throw new Error("test model missing");
    await session.setModel({ ...session.model, id: "local-second-model", reasoning: true });
    session.setThinkingLevel("high");
    const updated = await bash.execute("updated-env-probe", {
      command: `printf '%s\\n' "$PI_MODEL" "$PI_REASONING_LEVEL"`,
    });
    expect(updated.content).toContainEqual({ type: "text", text: "local-second-model\nhigh\n" });
  } finally {
    await created?.dispose();
    if (previousSocket === undefined) delete Bun.env.COFORGE_SUPERVISOR_SOCKET;
    else Bun.env.COFORGE_SUPERVISOR_SOCKET = previousSocket;
    await rm(root, { recursive: true, force: true });
  }
});

test("an awaiting SDK extension cannot expose Agent overrides to another local launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-initialization-env-"));
  const previous = Bun.env.COFORGE_TEST_RUNTIME_VALUE;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response("continue");
    },
  });
  let pending: ReturnType<typeof createSession> | undefined;
  try {
    Bun.env.COFORGE_TEST_RUNTIME_VALUE = "host-baseline";
    const extensions = join(root, ".pi", "extensions");
    await mkdir(extensions, { recursive: true });
    await Bun.write(
      join(extensions, "gate.ts"),
      `export default async function () { await fetch("http://127.0.0.1:${server.port}/gate"); }`,
    );
    pending = createSession({
      cwd: root,
      apiKey: "local-test-key",
      instructions: "Test only.",
      environment: { COFORGE_TEST_RUNTIME_VALUE: "agent-A" },
    });
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("SDK did not await the extension");
      }),
    ]);
    expect(Bun.env.COFORGE_TEST_RUNTIME_VALUE).toBe("host-baseline");
    const child = Bun.spawn({
      cmd: ["sh", "-c", 'printf "%s" "$COFORGE_TEST_RUNTIME_VALUE"'],
      env: { ...Bun.env },
      stdout: "pipe",
    });
    expect(await new Response(child.stdout).text()).toBe("host-baseline");
    expect(await child.exited).toBe(0);
  } finally {
    release.resolve();
    await (await pending)?.dispose();
    server.stop(true);
    if (previous === undefined) delete Bun.env.COFORGE_TEST_RUNTIME_VALUE;
    else Bun.env.COFORGE_TEST_RUNTIME_VALUE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK auth and model requests use each session's overrides without changing the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-request-env-"));
  const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
  const previousKey = Bun.env.OPENROUTER_API_KEY;
  const seen: string[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization") ?? "missing");
      return new Response(
        `data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta: { role: "assistant", content: "probe-ok" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    Bun.env.OPENROUTER_API_KEY = "host-synthetic-key";
    for (const name of ["first", "second"]) {
      const cwd = join(root, name);
      await mkdir(cwd);
      await Bun.write(
        join(cwd, ".builtin-runtime", "settings.json"),
        JSON.stringify({
          compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
        }),
      );
      const created = await createSession({
        cwd,
        apiKey: "selected-provider-key",
        instructions: "Test only.",
        modelProvider: "anthropic",
        environment: { OPENROUTER_API_KEY: `${name}-synthetic-key`, NO_PROXY: "*" },
      });
      sessions.push(created);
    }
    await Promise.all(
      sessions.map(async ({ session, services }, index) => {
        const runtime = services.modelRuntime;
        runtime.registerProvider("openrouter", {
          baseUrl: `http://127.0.0.1:${receiver.port}/v1`,
          api: "openai-completions",
        });
        const expected = index === 0 ? "first-synthetic-key" : "second-synthetic-key";
        expect((await runtime.getAuth("openrouter"))?.auth.apiKey).toBe(expected);
        expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("selected-provider-key");
        const model = runtime.getModel("openrouter", "openai/gpt-4o-mini");
        if (!model) throw new Error("test model missing");
        const context = {
          messages: [{ role: "user" as const, content: "probe", timestamp: Date.now() }],
        };
        for (const request of [
          () => runtime.streamSimple(model, context).result(),
          () => runtime.stream(model, context).result(),
          () => runtime.complete(model, context),
          async () => (await session.agent.streamFunction(model, context, {})).result(),
        ]) {
          const result = await request();
          expect(result.errorMessage).toBeUndefined();
          expect(result.stopReason).toBe("stop");
          expect(result.content).toContainEqual({ type: "text", text: "probe-ok" });
        }
        await session.setModel(model);
        await session.prompt("First local probe: " + "history ".repeat(50));
        await session.prompt("Second local probe");
        expect(seen.filter((value) => value === `Bearer ${expected}`)).toHaveLength(6);
        const compacted = await session.compact();
        expect(compacted.summary).toContain("probe-ok");
        expect(seen.filter((value) => value === `Bearer ${expected}`).length).toBeGreaterThan(6);
      }),
    );
    expect(
      seen.every((value) =>
        ["Bearer first-synthetic-key", "Bearer second-synthetic-key"].includes(value),
      ),
    ).toBe(true);
    expect(Bun.env.OPENROUTER_API_KEY).toBe("host-synthetic-key");
  } finally {
    for (const session of sessions) await session.dispose();
    receiver.stop(true);
    if (previousKey === undefined) delete Bun.env.OPENROUTER_API_KEY;
    else Bun.env.OPENROUTER_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});
