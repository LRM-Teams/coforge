import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills } from "../src/code-agent/agent-skills";

// macOS tmpdir lives under /var, a symlink; listAgentSkills rejects linked roots.
const tempRoot = realpathSync(tmpdir());

test("Skills metadata distinguishes native global and workspace roots and rereads on request", async () => {
  const root = await mkdtemp(join(tempRoot, "coforge-skills-"));
  const home = join(root, "home"),
    cwd = join(root, "agent");
  try {
    for (const dir of [
      ".claude/skills",
      ".agents/skills",
      ".pi/agent/skills",
      ".kiro/skills",
      ".cursor/skills",
    ]) {
      await Bun.write(
        join(home, dir, "review/SKILL.md"),
        "---\nname: review\ndescription: 'Global: review'\n---\nNEVER REPORT BODY",
      );
    }
    for (const dir of [
      ".claude/skills",
      ".agents/skills",
      ".pi/skills",
      ".kiro/skills",
      ".cursor/skills",
    ]) {
      await Bun.write(
        join(cwd, dir, "review/SKILL.md"),
        "---\nname: review\ndescription: >\n  Workspace review\n---\nBODY",
      );
    }
    for (const provider of ["claude-code", "codex", "kiro", "cursor", "pi", "coforge"] as const) {
      const result = await listAgentSkills({
        provider,
        agentWorkspaceDirectory: cwd,
        environment: { HOME: home },
      });
      expect(
        result.workspace.entries.some(
          (entry) =>
            entry.name === "review" &&
            entry.displayName === "review" &&
            entry.description === "Workspace review",
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
    const updated = await listAgentSkills({
      provider: "claude-code",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });
    expect(updated.global.entries[0]?.description).toBe("Updated");
    // `name` is the directory name, never the frontmatter `name`; `displayName` follows the
    // frontmatter value.
    expect(updated.global.entries[0]?.name).toBe("review");
    expect(updated.global.entries[0]?.displayName).toBe("review");
    expect(await Bun.file(file).text()).toBe(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kiro Skills use KIRO_HOME without scanning the fallback home root", async () => {
  const root = await mkdtemp(join(tempRoot, "kiro-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home"),
    kiroHome = join(root, "configured-kiro");
  try {
    const skill = "---\nname: kiro-review\ndescription: Kiro review\n---\nprivate";
    await Bun.write(join(cwd, ".kiro/skills/local/SKILL.md"), skill);
    await Bun.write(join(kiroHome, "skills/global/SKILL.md"), skill);
    await Bun.write(join(home, ".kiro/skills/must-not-scan/SKILL.md"), skill);

    const result = await listAgentSkills({
      provider: "kiro",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, KIRO_HOME: kiroHome },
    });

    // `name` is the containing directory, `sourcePath` is the scanned root (not the file);
    // `displayName` still follows the frontmatter `name`.
    expect(result.workspace.entries).toEqual([
      {
        name: "local",
        displayName: "kiro-review",
        description: "Kiro review",
        userInvocable: false,
        sourcePath: ".kiro/skills",
      },
    ]);
    expect(result.global.entries).toEqual([
      {
        name: "global",
        displayName: "kiro-review",
        description: "Kiro review",
        userInvocable: false,
        sourcePath: "$KIRO_HOME/skills",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native command conventions differ from Pi markdown skills", async () => {
  const root = await mkdtemp(join(tempRoot, "skills-conventions-"));
  try {
    await Bun.write(join(root, ".claude/commands/team/review.md"), "Review this change");
    await Bun.write(join(root, ".pi/skills/not-a-skill.md"), "No metadata");
    const claude = await listAgentSkills({
      provider: "claude-code",
      agentWorkspaceDirectory: root,
      environment: { HOME: root },
    });
    expect(claude.workspace.entries).toEqual([
      {
        name: "review",
        displayName: "review",
        description: "",
        userInvocable: false,
        sourcePath: ".claude/commands",
      },
    ]);
    const pi = await listAgentSkills({ provider: "coforge", agentWorkspaceDirectory: root });
    expect(pi.workspace.entries).toEqual([]);
    expect(pi.workspace.status).toBe("partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata queries bound malformed files, preserve duplicate sources and reject escaping symlinks", async () => {
  const root = await mkdtemp(join(tempRoot, "skills-boundaries-"));
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
    // `name` comes from each skill's own directory ("one"/"two"), so both survive the
    // dedup-by-name pass even though they share one scanned root.
    expect(result.workspace.entries.map((entry) => entry.name)).toEqual(["one", "two"]);
    expect(result.workspace.entries.every((entry) => entry.sourcePath === ".agents/skills")).toBe(
      true,
    );
    expect(result.workspace.entries.every((entry) => entry.displayName === "review")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(home);
    expect(JSON.stringify(result)).not.toContain("private");
    await Bun.write(join(root, "native/skills/custom/SKILL.md"), content);
    const native = await listAgentSkills({
      provider: "claude-code",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, CLAUDE_CONFIG_DIR: join(root, "native") },
    });
    expect(native.global.entries[0]).toMatchObject({
      name: "custom",
      displayName: "review",
      sourcePath: "$CLAUDE_CONFIG_DIR/skills",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("userInvocable reads the frontmatter flag and entries dedup by name across scanned roots", async () => {
  const root = await mkdtemp(join(tempRoot, "skills-dedup-"));
  try {
    const cwd = join(root, "agent");
    // Codex workspace scans both `.agents/skills` and `.codex/skills`; a "review" skill in the
    // first root must win over a same-named skill in the second.
    await Bun.write(
      join(cwd, ".agents/skills/review/SKILL.md"),
      "---\nname: Review\ndescription: First root\nuser-invocable: true\n---\nbody",
    );
    await Bun.write(
      join(cwd, ".codex/skills/review/SKILL.md"),
      "---\nname: Review\ndescription: Second root\n---\nbody",
    );
    await Bun.write(
      join(cwd, ".codex/skills/other/SKILL.md"),
      '---\nname: Other\ndescription: Not invoked\nuser-invocable: "true"\n---\nbody',
    );
    const result = await listAgentSkills({ provider: "codex", agentWorkspaceDirectory: cwd });
    expect(result.workspace.entries.map((entry) => entry.name)).toEqual(["other", "review"]);
    const review = result.workspace.entries.find((entry) => entry.name === "review");
    expect(review).toMatchObject({
      displayName: "Review",
      description: "First root",
      userInvocable: true,
      sourcePath: ".agents/skills",
    });
    const other = result.workspace.entries.find((entry) => entry.name === "other");
    expect(other?.userInvocable).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
