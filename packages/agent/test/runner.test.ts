import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
