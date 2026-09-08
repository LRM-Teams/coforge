import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "../src/code-agent/agent-skills";

test("Skills metadata distinguishes native global and workspace roots and rereads on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-skills-"));
  const home = join(root, "home"),
    cwd = join(root, "agent");
  try {
    for (const dir of [".claude/skills", ".agents/skills", ".pi/agent/skills"]) {
      await Bun.write(
        join(home, dir, "review/SKILL.md"),
        "---\nname: review\ndescription: 'Global: review'\n---\nNEVER REPORT BODY",
      );
    }
    for (const dir of [".claude/skills", ".agents/skills", ".pi/skills"]) {
      await Bun.write(
        join(cwd, dir, "review/SKILL.md"),
        "---\nname: review\ndescription: >\n  Workspace review\n---\nBODY",
      );
    }
    for (const provider of ["claude-code", "codex", "pi", "coforge"] as const) {
      const result = await listAgentSkills({
        provider,
        agentWorkspaceDirectory: cwd,
        environment: { HOME: home },
      });
      expect(
        result.workspace.entries.some(
          (entry) => entry.name === "review" && entry.description === "Workspace review",
        ),
      ).toBe(true);
      if (provider === "coforge") expect(result.global.status).toBe("unsupported");
      else
        expect(result.global.entries.some((entry) => entry.description === "Global: review")).toBe(
          true,
        );
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("BODY");
    }
    const file = join(home, ".claude/skills/review/SKILL.md");
    const content = "---\nname: review\ndescription: Updated\n---\nPrivate body";
    await Bun.write(file, content);
    expect(
      (
        await listAgentSkills({
          provider: "claude-code",
          agentWorkspaceDirectory: cwd,
          environment: { HOME: home },
        })
      ).global.entries[0]?.description,
    ).toBe("Updated");
    expect(await Bun.file(file).text()).toBe(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native command conventions differ from Pi markdown skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-conventions-"));
  try {
    await Bun.write(join(root, ".claude/commands/team/review.md"), "Review this change");
    await Bun.write(join(root, ".pi/skills/not-a-skill.md"), "No metadata");
    const claude = await listAgentSkills({
      provider: "claude-code",
      agentWorkspaceDirectory: root,
      environment: { HOME: root },
    });
    expect(claude.workspace.entries).toEqual([
      { name: "review", description: "", sourcePath: ".claude/commands/team/review.md" },
    ]);
    const pi = await listAgentSkills({ provider: "coforge", agentWorkspaceDirectory: root });
    expect(pi.workspace.entries).toEqual([]);
    expect(pi.workspace.status).toBe("partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata queries bound malformed files, preserve duplicate sources and reject escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-boundaries-"));
  try {
    const cwd = join(root, "agent"),
      home = join(root, "home");
    const content = "---\nname: review\ndescription: safe\n---\nprivate";
    for (const name of ["one", "two"])
      await Bun.write(join(cwd, `.agents/skills/${name}/SKILL.md`), content);
    await Bun.write(join(cwd, ".agents/skills/large/SKILL.md"), "x".repeat(262_145));
    await Bun.write(join(cwd, ".agents/skills/invalid/SKILL.md"), "---\nname: [bad\n---\nsecret");
    await Bun.write(join(home, "outside/SKILL.md"), content);
    await symlink(join(home, "outside"), join(cwd, ".agents/skills/escape"));
    await symlink(join(home, "outside"), join(cwd, ".pi"));
    const result = await listAgentSkills({ provider: "coforge", agentWorkspaceDirectory: cwd });
    expect(result.workspace.status).toBe("partial");
    expect(result.workspace.entries.map((entry) => entry.sourcePath)).toEqual([
      ".agents/skills/one/SKILL.md",
      ".agents/skills/two/SKILL.md",
    ]);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(JSON.stringify(result)).not.toContain("private");
    await Bun.write(join(root, "native/skills/custom/SKILL.md"), content);
    const native = await listAgentSkills({
      provider: "claude-code",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, CLAUDE_CONFIG_DIR: join(root, "native") },
    });
    expect(native.global.entries[0]?.sourcePath).toBe("$CLAUDE_CONFIG_DIR/skills/custom/SKILL.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
