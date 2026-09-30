import { asRecord } from "#src/code-agent/json-record";

/**
 * agy's own tool names and the CoForge tool each one is, with the single argument that carries its
 * summary. The argument names are the ones agy 1.2.13 sends in `tool_info.parameters`
 * (`CommandLine`, `AbsolutePath`, `TargetFile`); the daemon core summarizes only its own canonical
 * fields, so only those move across. A tool whose argument names were not observed keeps the
 * canonical name alone.
 */
const CANONICAL_TOOLS: Readonly<Record<string, { name: string; argument?: [string, string] }>> = {
  run_command: { name: "bash", argument: ["CommandLine", "command"] },
  view_file: { name: "read_file", argument: ["AbsolutePath", "file_path"] },
  write_to_file: { name: "write_file", argument: ["TargetFile", "file_path"] },
  replace_file_content: { name: "edit_file", argument: ["TargetFile", "file_path"] },
  multi_replace_file_content: { name: "edit_file", argument: ["TargetFile", "file_path"] },
  grep_search: { name: "grep" },
  find_by_name: { name: "glob" },
  search_web: { name: "web_search" },
  read_url_content: { name: "web_fetch" },
};

/** The tool-start name and input for one agy tool step. A tool not in the table keeps agy's own
 * name and arguments, which the daemon core reports by name only. */
export function antigravityToolCall(
  name: string,
  parameters: unknown,
): { name: string; input: unknown } {
  const canonical = CANONICAL_TOOLS[name];
  if (!canonical) return { name, input: parameters };
  const value = canonical.argument && asRecord(parameters)?.[canonical.argument[0]];
  return {
    name: canonical.name,
    input:
      canonical.argument && typeof value === "string" ? { [canonical.argument[1]]: value } : {},
  };
}

/** The tool-start input for a step that hands work to subagents: each subagent's role and type.
 * Their prompts, conversation ids and local log and workspace paths stay on the Computer. */
export function antigravitySubagentInput(subagentInfo: unknown): {
  subagents: Array<{ role: string; type: string }>;
} {
  const subagents = asRecord(subagentInfo)?.subagents;
  return {
    subagents: (Array.isArray(subagents) ? subagents : []).flatMap((raw) => {
      const subagent = asRecord(raw);
      return typeof subagent?.role === "string"
        ? [
            {
              role: subagent.role,
              type: typeof subagent.type_name === "string" ? subagent.type_name : "",
            },
          ]
        : [];
    }),
  };
}
