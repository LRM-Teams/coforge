/**
 * LifelongAgentBench (arXiv 2505.11942, github caixd-220529/LifelongAgentBench,
 * HF csyq/LifelongAgentBench) → evolbench-collab manifest adapter.
 *
 * The official lifelong protocol is one fixed sequential stream per task type
 * (db_bench / os_interaction / knowledge_graph), with cross-task experience
 * injected by the Previous-Samples callback. The group-chat mapping keeps the
 * stream order and swaps the callback for the Memory Agent: warm arm drains
 * every episode into OpenViking and recalls via @memory; cold arm runs each
 * episode in a zero-state workspace. Environments (mysql / os container /
 * Freebase SPARQL endpoint) stay external sidecars the Task Agent reaches with
 * its shell — see README for the sidecar wiring.
 */

export type LlabTaskType = "db_bench" | "os_interaction" | "knowledge_graph";

export type LlabManifestEpisode = {
  benchmark: string;
  episode_id: string;
  task_id: string;
  family_id: string;
  domain: string;
  split: "test";
  role: "qa";
  order: number;
  turns: [{ prompt: string }];
  grader: {
    kind: string;
    answer_ref: unknown;
  };
  upstream: { repo: string; task_type: LlabTaskType; sample_index: number };
};

type RawEntry = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * The HF rows keep answer_info / table_info / skill_list as JSON-encoded
 * strings; the local entry_dict.json keeps them as objects. Both shapes are
 * accepted.
 */
function decodeField(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const LLAB_ENV_NOTES: Record<LlabTaskType, string> = {
  db_bench:
    "Environment: a MySQL sidecar is available; use its connection details from the env note variable to inspect and query the provided database before writing your final SQL answer.",
  os_interaction:
    "Environment: an OS sidecar is available; use its connection details from the env note variable to run initialization and shell commands before posting your final answer.",
  knowledge_graph:
    "Environment: a Freebase SPARQL endpoint and the KG action API are available; use the connection details from the env note variable for get_relations/get_neighbors/intersection/get_attributes/count actions before posting your final answer.",
};

export function llabGraderKind(taskType: LlabTaskType): string {
  if (taskType === "db_bench") return "llmab_db_official";
  if (taskType === "os_interaction") return "llmab_os_official";
  return "llmab_kg_official";
}

/** The answer reference never enters the prompt; it rides the grader block. */
function answerRef(taskType: LlabTaskType, entry: RawEntry): unknown {
  if (taskType === "knowledge_graph") {
    return { answer_list: entry.answer_list ?? decodeField(entry.answer_list) ?? [] };
  }
  return { answer_info: decodeField(entry.answer_info) };
}

export function convertLlabEntries(input: {
  taskType: LlabTaskType;
  entries: readonly RawEntry[];
  limit?: number;
}): LlabManifestEpisode[] {
  const episodes: LlabManifestEpisode[] = [];
  const capped = input.limit ? input.entries.slice(0, input.limit) : input.entries;
  for (const [index, entry] of capped.entries()) {
    // db_bench / os_interaction rows carry `instruction`; knowledge_graph
    // rows carry `question`.
    const instruction = text(entry.instruction) || text(entry.question);
    if (!instruction) throw new Error(`entry ${index} has no instruction`);
    const sampleIndex = Number(entry.sample_index ?? index);
    episodes.push({
      benchmark: "lifelongagentbench",
      episode_id: `llmab-${input.taskType}-${sampleIndex}`,
      task_id: String(sampleIndex),
      family_id: `llmab_${input.taskType}`,
      domain: input.taskType,
      split: "test",
      role: "qa",
      order: index + 1,
      turns: [{ prompt: `${instruction}\n\n${LLAB_ENV_NOTES[input.taskType]}` }],
      grader: { kind: llabGraderKind(input.taskType), answer_ref: answerRef(input.taskType, entry) },
      upstream: {
        repo: "caixd-220529/LifelongAgentBench",
        task_type: input.taskType,
        sample_index: sampleIndex,
      },
    });
  }
  if (episodes.length === 0) throw new Error("no entries converted");
  return episodes;
}

/** Accepts both the local entry_dict.json (array or index→entry map) and the
 * HF-exported jsonl (one entry per line). */
export async function loadLlabEntries(path: string): Promise<RawEntry[]> {
  const raw = await Bun.file(path).text();
  if (path.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RawEntry);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as RawEntry[];
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, RawEntry>).map(([key, value]) => ({
      sample_index: key,
      ...value,
    }));
  }
  throw new Error(`unrecognized entry format in ${path}`);
}
