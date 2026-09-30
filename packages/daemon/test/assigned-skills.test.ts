import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignedSkillsDirectory,
  installAssignedSkills,
  parseAssignedSkillPacks,
} from "#src/code-agent/assigned-skills";
import { listAgentSkills } from "#src/code-agent/agent-skills";

/** macOS `TMPDIR` is `/var/folders/...` and `/var` is a symlink to `/private/var`, while the skill
 * scanner rejects any root whose `realpath` differs from its resolved path. Create fixtures under
 * an already-canonical root so the scan sees the directory it was given. */
async function createFixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

test("assigned skill packs install into provider-native workspace roots", async () => {
  const root = await createFixtureRoot("coforge-assigned-skills-");
  try {
    const result = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.written).toEqual([
      "weekly-report-navigation",
      "weekly-report-web-export",
      "weekly-report-writing",
    ]);
    expect(result.skipped).toEqual([]);
    expect(assignedSkillsDirectory("coforge", root)).toBe(join(root, ".pi", "skills"));

    const listed = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
    });
    expect(listed.workspace.entries.map((entry) => entry.name).sort()).toEqual([
      "weekly-report-navigation",
      "weekly-report-web-export",
      "weekly-report-writing",
    ]);
    expect(JSON.stringify(listed)).not.toContain("Progressive loading");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assigned skill install never overwrites an existing same-named skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-assigned-skills-skip-"));
  try {
    const skillPath = join(root, ".pi", "skills", "weekly-report-privacy", "SKILL.md");
    await Bun.write(
      skillPath,
      "---\nname: weekly-report-privacy\ndescription: User owned\n---\nKEEP",
    );
    const result = await installAssignedSkills({
      provider: "pi",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.skipped).toContain("weekly-report-privacy");
    expect(await Bun.file(skillPath).text()).toContain("KEEP");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assignedSkillsDirectory places Cursor packs under .cursor/skills", () => {
  expect(assignedSkillsDirectory("cursor", "/workspace")).toBe(
    join("/workspace", ".cursor", "skills"),
  );
});

test("assignedSkillsDirectory places Antigravity packs under .agents/skills", () => {
  expect(assignedSkillsDirectory("antigravity", "/workspace")).toBe(
    join("/workspace", ".agents", "skills"),
  );
});

test("parseAssignedSkillPacks accepts only known packs", () => {
  expect(parseAssignedSkillPacks(["weekly-report", "weekly-report", "other"])).toEqual([
    "weekly-report",
  ]);
  expect(parseAssignedSkillPacks(undefined)).toEqual([]);
});

test("assigned skills refresh an unchanged managed version and preserve subsequent user edits", async () => {
  const root = await createFixtureRoot("coforge-assigned-upgrade-");
  const options = {
    provider: "coforge" as const,
    agentWorkspaceDirectory: root,
    packs: ["weekly-report" as const],
  };
  try {
    await installAssignedSkills(options);
    const directory = join(root, ".pi", "skills", "weekly-report-navigation");
    const path = join(directory, "SKILL.md");
    const current = await Bun.file(path).text();
    const previous =
      "---\nname: weekly-report-navigation\ndescription: Previous managed version\n---\nOld workflow";
    await Bun.write(path, previous);
    await Bun.write(
      join(directory, ".coforge-content-sha256"),
      new Bun.CryptoHasher("sha256").update(previous).digest("hex"),
    );
    expect((await installAssignedSkills(options)).written).toContain("weekly-report-navigation");
    expect(await Bun.file(path).text()).toBe(current);
    await Bun.write(path, current + "\nUser customization");
    expect((await installAssignedSkills(options)).skipped).toContain("weekly-report-navigation");
    expect(await Bun.file(path).text()).toEndWith("User customization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades exact legacy skills and retires only unchanged redundant skills", async () => {
  const root = await createFixtureRoot("coforge-assigned-legacy-");
  try {
    const directory = join(root, ".pi", "skills");
    for (const name of ["navigation", "review"]) {
      await Bun.write(
        join(directory, `weekly-report-${name}`, "SKILL.md"),
        await Bun.file(join(import.meta.dir, `fixtures/weekly-report-${name}-legacy.txt`)).text(),
      );
    }
    const custom = join(directory, "weekly-report-privacy", "SKILL.md");
    await Bun.write(custom, "---\nname: weekly-report-privacy\ndescription: Custom\n---\nKEEP");
    const result = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.written).toContain("weekly-report-navigation");
    expect(await Bun.file(join(directory, "weekly-report-review", "SKILL.md")).exists()).toBe(
      false,
    );
    expect(await Bun.file(custom).text()).toContain("KEEP");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["directory", "marker"] as const)(
  "preserves user %s symlinks during skill installation",
  async (kind) => {
    const root = await createFixtureRoot("coforge-assigned-links-");
    const outside = await createFixtureRoot("coforge-user-skills-");
    const options = {
      provider: "coforge" as const,
      agentWorkspaceDirectory: root,
      packs: ["weekly-report" as const],
    };
    const directory = join(root, ".pi", "skills", "weekly-report-navigation");
    try {
      if (kind === "directory") {
        await mkdir(join(root, ".pi", "skills"), { recursive: true });
        await symlink(outside, directory, "dir");
      } else {
        await installAssignedSkills(options);
        const marker = join(directory, ".coforge-content-sha256");
        await rm(marker);
        await Bun.write(join(outside, "user-file"), "KEEP");
        await symlink(join(outside, "user-file"), marker);
      }
      const result = await installAssignedSkills(options);
      expect(result.skipped).toContain("weekly-report-navigation");
      expect(await Bun.file(join(outside, "SKILL.md")).exists()).toBe(false);
      if (kind === "marker") expect(await Bun.file(join(outside, "user-file")).text()).toBe("KEEP");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);
