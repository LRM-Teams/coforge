// Opt-in: mise exec -- bun test ./packages/daemon/test/kiro-native.integration.ts
// Requires a user-installed, authenticated Kiro v3 engine; consumes provider usage.
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { discoverKiroCatalog } from "#src/code-agent/kiro/catalog";
import { KIRO_ACP_ARGS } from "#src/code-agent/kiro/connection";

// macOS tmpdir lives under /var, a symlink; the Kiro provider rejects a linked
// agent profile directory (comparing realpath to the literal resolved path).
const tempRoot = realpathSync(tmpdir());

test("native Kiro v3 instructions, permissions, recovery and busy steering", async () => {
  const cwd = await mkdtemp(join(tempRoot, "coforge-kiro-native-"));
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
    session = await new KiroProvider().createAgentSession({
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
    session = await new KiroProvider().createAgentSession({
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
    // notify() while busy steers the live turn through Kiro's own ACP
    // `_session/steer` extension instead of replacing it with a new prompt — the running tool
    // keeps running (steering never cancels in-flight work; only interrupt() does that), and the
    // steered text reaches the model at its next boundary.
    completed = Promise.withResolvers<string>();
    tool = Promise.withResolvers<void>();
    text = "";
    await session.notify!(
      "Run sleep 8; printf DONE > delayed-marker.txt in the foreground shell now, and wait for completion.",
    );
    await tool.promise;
    await session.notify!(
      "Remember the steered marker EMBER-042 and mention it once the shell command finishes.",
    );
    expect(await completed.promise).toBe("completed");
    expect(text).toContain("EMBER-042");
    await session.dispose();
    expect(await Bun.file(join(cwd, "delayed-marker.txt")).text()).toBe("DONE");
  } finally {
    await session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
