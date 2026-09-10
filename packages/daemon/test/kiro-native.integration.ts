// Opt-in: mise exec -- bun test ./packages/daemon/test/kiro-native.integration.ts
// Requires a user-installed, authenticated Kiro v3 engine; consumes provider usage.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { KiroDriver } from "../src/code-agent/kiro/driver";
import { discoverKiroCatalog } from "../src/code-agent/kiro/catalog";
import { KIRO_ACP_ARGS } from "../src/code-agent/kiro/connection";

test("native Kiro v3 instructions, permissions, recovery and busy admission", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-kiro-native-"));
  let session: AgentSession | undefined;
  let completed = Promise.withResolvers<string>();
  let tool = Promise.withResolvers<void>();
  let text = "";
  const listen = (event: AgentRuntimeEvent) => {
    if (event.type === "text-delta") text += event.text;
    if (event.type === "completed") completed.resolve(event.status);
    if (event.type === "tool-start") tool.resolve();
  };
  const options = {
    agentWorkspaceDirectory: cwd,
    instructions:
      "When asked for the instruction marker, reply exactly CEDAR-951. Use tools only when requested.",
  };
  try {
    const catalog = await discoverKiroCatalog(["kiro-cli", ...KIRO_ACP_ARGS], cwd, Bun.env);
    const model = catalog?.models.find((model) => model.reasoningEfforts.includes("low"));
    expect(model).toBeDefined();
    session = await new KiroDriver().createAgentSession({
      ...options,
      runtime: { provider: "kiro", model: model!.id, reasoning: "low" },
    });
    session.subscribe(listen);
    await session.notify!("What is the instruction marker? Reply only with it.");
    expect(await completed.promise).toBe("completed");
    expect(text).toContain("CEDAR-951");
    completed = Promise.withResolvers<string>();
    await session.notify!(
      "Remember the conversation marker VIOLET-683. Run printf TOOL-719 > tool-marker.txt using your shell tool.",
    );
    expect(await completed.promise).toBe("completed");
    expect(await Bun.file(join(cwd, "tool-marker.txt")).text()).toBe("TOOL-719");
    const identity = await session.readSessionIdentity!();
    await session.dispose();
    session = await new KiroDriver().createAgentSession({
      ...options,
      sessionId: identity!.sessionId,
    });
    session.subscribe(listen);
    completed = Promise.withResolvers<string>();
    text = "";
    await session.notify!(
      "Repeat the conversation marker from earlier, not the instruction marker.",
    );
    expect(await completed.promise).toBe("completed");
    expect(text).toContain("VIOLET-683");
    completed = Promise.withResolvers<string>();
    tool = Promise.withResolvers<void>();
    text = "";
    await session.notify!(
      "Run sleep 30; printf OLD > delayed-marker.txt in the foreground shell now, and wait for completion.",
    );
    await tool.promise;
    await session.notify!(
      "Cancel the previous work. Do not use tools. Reply exactly REPLACED-719.",
    );
    expect(await completed.promise).toBe("completed");
    expect(text).toContain("REPLACED-719");
    await session.dispose();
    expect(await Bun.file(join(cwd, "delayed-marker.txt")).exists()).toBe(false);
  } finally {
    await session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
