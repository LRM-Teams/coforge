import { createAgentActivity } from "../agent-runtime/agent-activity";

// Verified Raft 1.0.18 aliases, plus the lowercase Pi tools and explicit patch
// tool used by our providers. Do not infer an operation by inspecting arbitrary args.
const aliases: Readonly<Record<string, string>> = {
  Read: "reading_file",
  read: "reading_file",
  ReadFile: "reading_file",
  read_file: "reading_file",
  file_read: "reading_file",
  Write: "writing_file",
  write: "writing_file",
  WriteFile: "writing_file",
  write_file: "writing_file",
  file_write: "writing_file",
  Edit: "editing_file",
  edit: "editing_file",
  EditFile: "editing_file",
  edit_file: "editing_file",
  file_change: "editing_file",
  StrReplaceFile: "editing_file",
  apply_patch: "editing_file",
  Bash: "running_command",
  bash: "running_command",
  shell: "running_command",
  Shell: "running_command",
  command_execution: "running_command",
  run_shell_command: "running_command",
  run_terminal_command: "running_command",
};

export function toolActivity(name: string, args: unknown, occurredAt?: string) {
  const activity = Object.hasOwn(aliases, name) ? aliases[name]! : "using_tool";
  const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const summary =
    activity === "running_command"
      ? input.command
      : activity !== "using_tool"
        ? (input.file_path ?? input.path)
        : undefined;
  const result = createAgentActivity(
    activity === "running_command" ? "running_command" : "tool_started",
    "info",
    typeof summary === "string" ? summary : name,
    occurredAt,
  );
  const canonical =
    activity === "reading_file"
      ? "read_file"
      : activity === "writing_file"
        ? "write_file"
        : activity === "editing_file"
          ? "edit_file"
          : activity === "running_command"
            ? "bash"
            : name;
  return {
    ...result,
    entries: [
      {
        kind: "tool_start" as const,
        toolName:
          [...canonical.replace(/[\x00-\x1f\x7f]/g, "")].slice(0, 128).join("") || "unknown",
      },
    ],
  };
}
