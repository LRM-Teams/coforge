import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills, scanAgentSkillScopes } from "#src/code-agent/agent-skills";

// macOS tmpdir lives under /var, a symlink; listAgentSkills rejects linked roots.
const tempRoot = realpathSync(tmpdir());

test("scans global and workspace skill scopes concurrently while preserving scope results", async () => {
  const globalRoots = [{ path: "/global", label: "global" }];
  const workspaceRoots = [{ path: "/workspace", label: "workspace" }];
  const started: string[] = [];
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });

  const scan = async (roots: readonly { label: string }[]) => {
    started.push(roots[0]!.label);
    if (started.length === 2) release();
    await allStarted;
    return {
      status: "ok" as const,
      entries: [],
      directories: [],
    };
  };

  await expect(
    scanAgentSkillScopes(globalRoots, workspaceRoots, Date.now() + 1_000, scan),
  ).resolves.toEqual({
    global: { status: "ok", entries: [], directories: [] },
    workspace: { status: "ok", entries: [], directories: [] },
  });
  expect(started).toEqual(["global", "workspace"]);
}, 3_000);

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
      ".gemini/config/skills",
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
    for (const provider of [
      "claude-code",
      "codex",
      "kiro",
      "cursor",
      "opencode",
      "grok",
      "antigravity",
      "pi",
      "coforge",
    ] as const) {
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

test("Antigravity Skills scan the workspace .agents root and only its own global directory", async () => {
  const root = await mkdtemp(join(tempRoot, "antigravity-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    const skill = "---\nname: agy-review\ndescription: Antigravity review\n---\nprivate";
    await Bun.write(join(cwd, ".agents/skills/local/SKILL.md"), skill);
    await Bun.write(join(home, ".gemini/config/skills/global/SKILL.md"), skill);
    // Roots the Antigravity CLI does not read: another CLI's personal root, and the CLI's own
    // state directory, which agy 1.2.13 ignores for skills.
    await Bun.write(join(home, ".agents/skills/must-not-scan/SKILL.md"), skill);
    await Bun.write(join(home, ".gemini/antigravity-cli/skills/must-not-scan/SKILL.md"), skill);

    const result = await listAgentSkills({
      provider: "antigravity",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });

    expect(result.workspace.entries).toEqual([
      {
        name: "local",
        displayName: "agy-review",
        description: "Antigravity review",
        userInvocable: false,
        sourcePath: ".agents/skills",
      },
    ]);
    expect(result.global.entries).toEqual([
      {
        name: "global",
        displayName: "agy-review",
        description: "Antigravity review",
        userInvocable: false,
        sourcePath: "~/.gemini/config/skills",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const rootSkill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nprivate`;
/** `[name, sourcePath]` pairs, so an assertion names every root a skill was found in. */
const found = (scope: { entries: readonly { name: string; sourcePath: string }[] }) =>
  scope.entries.map((entry) => [entry.name, entry.sourcePath]);

test("OpenCode Skills scan its own, the Claude-compatible and the agent-compatible roots", async () => {
  const root = await mkdtemp(join(tempRoot, "opencode-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    for (const [dir, name] of [
      [".opencode/skills", "local-opencode"],
      [".opencode/skill", "local-opencode-legacy"],
      [".claude/skills", "local-claude"],
      [".agents/skills", "local-agents"],
      // Roots of other CLIs, which OpenCode does not read.
      [".cursor/skills", "must-not-scan"],
      [".grok/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(cwd, dir, name, "SKILL.md"), rootSkill(name));
    for (const [dir, name] of [
      [".config/opencode/skills", "global-opencode"],
      [".config/opencode/skill", "global-opencode-legacy"],
      [".claude/skills", "global-claude"],
      [".agents/skills", "global-agents"],
      [".opencode/skills", "must-not-scan"],
      [".cursor/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(home, dir, name, "SKILL.md"), rootSkill(name));

    const result = await listAgentSkills({
      provider: "opencode",
      agentWorkspaceDirectory: cwd,
      // Hosts such as GitHub's Linux runners set XDG_CONFIG_HOME; clear it so the fallback
      // `~/.config` root is the one under test.
      environment: { HOME: home, XDG_CONFIG_HOME: "" },
    });

    expect(found(result.workspace)).toEqual([
      ["local-agents", ".agents/skills"],
      ["local-claude", ".claude/skills"],
      ["local-opencode", ".opencode/skills"],
      ["local-opencode-legacy", ".opencode/skill"],
    ]);
    expect(found(result.global)).toEqual([
      ["global-agents", "~/.agents/skills"],
      ["global-claude", "~/.claude/skills"],
      ["global-opencode", "~/.config/opencode/skills"],
      ["global-opencode-legacy", "~/.config/opencode/skill"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode Skills follow XDG_CONFIG_HOME without scanning the fallback config root", async () => {
  const root = await mkdtemp(join(tempRoot, "opencode-xdg-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home"),
    xdg = join(root, "xdg-config");
  try {
    await Bun.write(join(xdg, "opencode/skills/xdg-skill/SKILL.md"), rootSkill("xdg-skill"));
    await Bun.write(join(xdg, "opencode/skill/xdg-legacy/SKILL.md"), rootSkill("xdg-legacy"));
    await Bun.write(join(home, ".config/opencode/skills/must-not-scan/SKILL.md"), rootSkill("x"));
    // The compatibility roots stay under HOME.
    await Bun.write(join(home, ".claude/skills/home-claude/SKILL.md"), rootSkill("home-claude"));

    const result = await listAgentSkills({
      provider: "opencode",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, XDG_CONFIG_HOME: xdg },
    });

    expect(found(result.global)).toEqual([
      ["home-claude", "~/.claude/skills"],
      ["xdg-legacy", "$XDG_CONFIG_HOME/opencode/skill"],
      ["xdg-skill", "$XDG_CONFIG_HOME/opencode/skills"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Skills list a shared root once per scope when the workspace is the home directory", async () => {
  const root = await mkdtemp(join(tempRoot, "shared-root-skills-"));
  try {
    await Bun.write(join(root, ".agents/skills/shared/SKILL.md"), rootSkill("shared"));
    await Bun.write(join(root, ".claude/skills/claude-only/SKILL.md"), rootSkill("claude-only"));
    for (const provider of ["opencode", "grok"] as const) {
      const result = await listAgentSkills({
        provider,
        agentWorkspaceDirectory: root,
        environment: { HOME: root },
      });
      const expected: [string, string][] = [
        ["claude-only", ".claude/skills"],
        ["shared", ".agents/skills"],
      ];
      expect(found(result.workspace)).toEqual(expected);
      expect(found(result.global)).toEqual(expected.map(([name, path]) => [name, `~/${path}`]));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor Skills scan its own, the agent-compatible and the Claude and Codex roots in both scopes", async () => {
  const root = await mkdtemp(join(tempRoot, "cursor-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    for (const [dir, name] of [
      [".cursor/skills", "local-cursor"],
      [".agents/skills", "local-agents"],
      [".claude/skills", "local-claude"],
      [".codex/skills", "local-codex"],
      [".opencode/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(cwd, dir, name, "SKILL.md"), rootSkill(name));
    for (const [dir, name] of [
      [".cursor/skills", "global-cursor"],
      [".agents/skills", "global-agents"],
      [".claude/skills", "global-claude"],
      [".codex/skills", "global-codex"],
      [".config/opencode/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(home, dir, name, "SKILL.md"), rootSkill(name));

    const result = await listAgentSkills({
      provider: "cursor",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });

    expect(found(result.workspace)).toEqual([
      ["local-agents", ".agents/skills"],
      ["local-claude", ".claude/skills"],
      ["local-codex", ".codex/skills"],
      ["local-cursor", ".cursor/skills"],
    ]);
    expect(found(result.global)).toEqual([
      ["global-agents", "~/.agents/skills"],
      ["global-claude", "~/.claude/skills"],
      ["global-codex", "~/.codex/skills"],
      ["global-cursor", "~/.cursor/skills"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok Skills scan its own, the agent-compatible and the Claude-compatible roots", async () => {
  const root = await mkdtemp(join(tempRoot, "grok-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home"),
    grokHome = join(root, "configured-grok");
  try {
    for (const [dir, name] of [
      [".grok/skills", "local-grok"],
      [".agents/skills", "local-agents"],
      [".claude/skills", "local-claude"],
      [".cursor/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(cwd, dir, name, "SKILL.md"), rootSkill(name));
    for (const [dir, name] of [
      [".grok/skills", "global-grok"],
      [".agents/skills", "global-agents"],
      [".claude/skills", "global-claude"],
      [".cursor/skills", "must-not-scan"],
    ] as const)
      await Bun.write(join(home, dir, name, "SKILL.md"), rootSkill(name));
    await Bun.write(join(grokHome, "skills/configured-grok/SKILL.md"), rootSkill("configured"));

    const plain = await listAgentSkills({
      provider: "grok",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });
    expect(found(plain.workspace)).toEqual([
      ["local-agents", ".agents/skills"],
      ["local-claude", ".claude/skills"],
      ["local-grok", ".grok/skills"],
    ]);
    expect(found(plain.global)).toEqual([
      ["global-agents", "~/.agents/skills"],
      ["global-claude", "~/.claude/skills"],
      ["global-grok", "~/.grok/skills"],
    ]);

    // GROK_HOME replaces only the `.grok` root; the shared roots stay under HOME.
    const configured = await listAgentSkills({
      provider: "grok",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home, GROK_HOME: grokHome },
    });
    expect(found(configured.global)).toEqual([
      ["configured-grok", "$GROK_HOME/skills"],
      ["global-agents", "~/.agents/skills"],
      ["global-claude", "~/.claude/skills"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the built-in CoForge Agent lists the ~/.agents/skills root the Pi SDK loads", async () => {
  const root = await mkdtemp(join(tempRoot, "builtin-skills-"));
  const cwd = join(root, "agent"),
    home = join(root, "home");
  try {
    await Bun.write(
      join(home, ".agents/skills/global-agents/SKILL.md"),
      rootSkill("global-agents"),
    );
    // Pi's own roots, which the built-in Agent's `.builtin-runtime` directory replaces.
    await Bun.write(join(home, ".pi/agent/skills/must-not-scan/SKILL.md"), rootSkill("x"));
    await Bun.write(join(cwd, ".agents/skills/local-agents/SKILL.md"), rootSkill("local-agents"));

    const result = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });

    expect(result.global.status).toBe("ok");
    expect(found(result.global)).toEqual([["global-agents", "~/.agents/skills"]]);
    expect(found(result.workspace)).toEqual([["local-agents", ".agents/skills"]]);

    // Without a home there is no global root to observe.
    const homeless = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: "" },
    });
    expect(homeless.global).toEqual({ status: "unsupported", entries: [], directories: [] });
    expect(found(homeless.workspace)).toEqual([["local-agents", ".agents/skills"]]);
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
    const pi = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      environment: { HOME: root },
    });
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
    const result = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: cwd,
      environment: { HOME: home },
    });
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
