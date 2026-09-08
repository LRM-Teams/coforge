import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/runner";

test("CoForge reopens the same Agent transcript and isolates explicit and other Agent sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-session-"));
  const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
  const open = async (agentId: string, sessionId?: string, sessionMode?: "create" | "resume") => {
    const created = await createSession({
      cwd,
      agentId,
      sessionId,
      sessionMode,
      apiKey: "test-only-not-a-provider-key",
      instructions: "Offline persistence regression",
    });
    sessions.push(created);
    return created;
  };
  try {
    const first = await open("agent-a");
    first.session.sessionManager.appendMessage({
      role: "user",
      content: "distinctive persisted question",
      timestamp: 1,
    });
    first.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "distinctive persisted answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const path = join(first.session.sessionManager.getSessionDir(), "renamed.jsonl");
    await first.dispose();
    await rename(first.session.sessionManager.getSessionFile()!, path);
    const restored = await open("agent-a");
    expect(restored.session.sessionManager.getSessionFile()).toBe(path);
    expect(JSON.stringify(restored.session.agent.state.messages)).toContain(
      "distinctive persisted answer",
    );
    const other = await open("agent-b");
    expect(other.session.agent.state.messages).toEqual([]);
    const explicit = await open("agent-a", "explicit-fresh", "create");
    expect(explicit.sessionId).toBe("explicit-fresh");
    expect(explicit.session.agent.state.messages).toEqual([]);
    await restored.dispose();
    await rm(path!);
    const fresh = await open("agent-a", "agent-a", "resume");
    expect(fresh.sessionId).not.toBe("agent-a");
    expect(fresh.session.agent.state.messages).toEqual([]);
    expect(fresh.replacedSessionId).toBe("agent-a");
    await writeFile(path!, "not a valid session\n");
    await expect(open("agent-a", "agent-a", "resume")).rejects.toThrow();
    await chmod(path!, 0);
    await expect(open("agent-a", "agent-a", "resume")).rejects.toThrow();
  } finally {
    for (const session of sessions) await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
