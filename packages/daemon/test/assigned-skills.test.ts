import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignedSkillsDirectory,
  installAssignedSkills,
  parseAssignedSkillPacks,
} from "../src/code-agent/assigned-skills";
import { listAgentSkills } from "../src/code-agent/agent-skills";

test("assigned skill packs install into provider-native workspace roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-assigned-skills-"));
  try {
    const result = await installAssignedSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
      packs: ["weekly-report"],
    });
    expect(result.written).toEqual([
      "weekly-report-navigation",
      "weekly-report-analysis",
      "weekly-report-writing",
      "weekly-report-review",
      "weekly-report-privacy",
    ]);
    expect(result.skipped).toEqual([]);
    expect(assignedSkillsDirectory("coforge", root)).toBe(join(root, ".pi", "skills"));

    const listed = await listAgentSkills({
      provider: "coforge",
      agentWorkspaceDirectory: root,
    });
    expect(listed.workspace.entries.map((entry) => entry.name).sort()).toEqual([
      "weekly-report-analysis",
      "weekly-report-navigation",
      "weekly-report-privacy",
      "weekly-report-review",
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

test("parseAssignedSkillPacks accepts only known packs", () => {
  expect(parseAssignedSkillPacks(["weekly-report", "weekly-report", "other"])).toEqual([
    "weekly-report",
  ]);
  expect(parseAssignedSkillPacks(undefined)).toEqual([]);
});
