import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convertLlabEntries, llabGraderKind, LLAB_ENV_NOTES } from "../adapters/lifelongagentbench";
import { convertSkillFlowTasks } from "../adapters/skillflow";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("lifelongagentbench adapter", () => {
  const entry = {
    sample_index: 0,
    instruction: "Insert a new payment record for member ID 102 ...",
    answer_info: JSON.stringify({ direct: null, md5: "03ae28a1...", sql: "INSERT INTO ..." }),
    skill_list: JSON.stringify(["insert", "values_only"]),
  };

  test("converts HF-shaped rows: order, family, env note, grader isolation", () => {
    const rows = convertLlabEntries({ taskType: "db_bench", entries: [entry, { ...entry, sample_index: 1 }] });
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.benchmark).toBe("lifelongagentbench");
    expect(first.family_id).toBe("llmab_db_bench");
    expect(first.order).toBe(1);
    expect(first.split).toBe("test");
    expect(first.turns[0]!.prompt).toContain("Insert a new payment record");
    expect(first.turns[0]!.prompt).toContain(LLAB_ENV_NOTES.db_bench);
    // The answer never rides the prompt; it rides the grader block.
    expect(first.turns[0]!.prompt).not.toContain("03ae28a1");
    expect(first.grader.kind).toBe(llabGraderKind("db_bench"));
    expect((first.grader.answer_ref as { answer_info: { md5: string } }).answer_info.md5).toBe("03ae28a1...");
  });

  test("knowledge_graph grader carries the answer set", () => {
    const rows = convertLlabEntries({
      taskType: "knowledge_graph",
      entries: [{ question: "who is...", entity_dict: {}, answer_list: ["m.01", "m.02"] }],
    });
    expect(rows[0]!.grader.kind).toBe("llmab_kg_official");
    expect((rows[0]!.grader.answer_ref as { answer_list: string[] }).answer_list).toEqual(["m.01", "m.02"]);
  });

  test("rejects empty conversions", () => {
    expect(() => convertLlabEntries({ taskType: "db_bench", entries: [] })).toThrow("no entries");
    expect(() =>
      convertLlabEntries({ taskType: "db_bench", entries: [{ sample_index: 9 }] }),
    ).toThrow("no instruction");
  });
});

describe("skillflow adapter", () => {
  test("converts a downloaded family: lexical difficulty order, Harbor grader ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-adapt-"));
    const family = join(root, "Compensation-Scenario-Modeling");
    await write(join(family, "01_foundation", "instruction.md"), "Build the model at `/root/x.xlsx`.\n");
    await write(join(family, "02_refresh", "instruction.md"), "Refresh the model.\n");
    const rows = await convertSkillFlowTasks({ tasksRoot: root });
    expect(rows.map((row) => row.task_id)).toEqual([
      "Compensation-Scenario-Modeling/01_foundation",
      "Compensation-Scenario-Modeling/02_refresh",
    ]);
    expect(rows[0]!.family_id).toBe("sf_Compensation-Scenario-Modeling");
    expect(rows[0]!.order).toBe(1);
    expect(rows[0]!.grader.kind).toBe("skillflow_harbor_verifier");
    expect(rows[0]!.grader.task_dir).toBe(join(family, "01_foundation"));
  });

  test("honors ALL_TASK_DIFFICULTY_RANKING.json over lexical order", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-rank-"));
    const family = join(root, "Fam");
    await write(join(family, "a_task", "instruction.md"), "A\n");
    await write(join(family, "z_task", "instruction.md"), "Z\n");
    await write(join(family, "ALL_TASK_DIFFICULTY_RANKING.json"), JSON.stringify(["z_task", "a_task"]));
    const rows = await convertSkillFlowTasks({ tasksRoot: root });
    expect(rows.map((row) => row.task_id)).toEqual(["Fam/z_task", "Fam/a_task"]);
  });

  test("family filter and missing instruction rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-filter-"));
    await write(join(root, "keep", "t1", "instruction.md"), "K\n");
    await write(join(root, "skip", "t2", "instruction.md"), "S\n");
    const filtered = await convertSkillFlowTasks({ tasksRoot: root, families: ["keep"] });
    expect(filtered).toHaveLength(1);
    await write(join(root, "empty", "t3", "notes.txt"), "no instruction\n");
    await expect(convertSkillFlowTasks({ tasksRoot: root, families: ["empty"] })).rejects.toThrow(
      "no instruction.md",
    );
  });
});
