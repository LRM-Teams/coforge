import type { ActivityEntry } from "./agent-activity";
import type { AgentDisplaySnapshot } from "@coforge/protocol/agent-display";

export type ActivityObservation = Pick<
  ActivityEntry,
  "activityKind" | "detailKind" | "detail" | "level" | "entries"
>;
type Tone = "working" | "thinking" | "idle" | "offline" | "error" | "output" | "unknown";
export type ActivityRow = {
  label: string;
  detail: string;
  recentLabel: string;
  currentLabel: string | null;
  tone: Tone;
  recentTone: Tone;
  pulse: boolean;
  monospace: boolean;
  expandable: boolean;
  subagent?: { parentToolUseId: string };
};

const toolLabels: Readonly<Record<string, string>> = {
  bash: "Running command",
  read_file: "Reading file",
  write_file: "Writing file",
  edit_file: "Editing file",
  glob: "Searching files",
  grep: "Searching code",
  web_fetch: "Fetching web",
  web_search: "Searching web",
  todo_write: "Updating tasks",
  send_message: "Sending message",
  check_messages: "Checking messages",
  receive_message: "Checking messages",
  wait_for_message: "Waiting for messages",
  read_history: "Reading history",
  search_messages: "Searching messages",
  list_server: "Listing server",
  list_tasks: "Listing tasks",
  create_tasks: "Creating tasks",
  claim_tasks: "Claiming tasks",
  unclaim_task: "Unclaiming task",
  update_task_status: "Updating task status",
  add_channel_member: "Adding channel member",
  join_channel: "Joining channel",
  leave_channel: "Leaving channel",
  upload_file: "Uploading file",
  view_file: "Viewing file",
  schedule_reminder: "Scheduling reminder",
  list_reminders: "Listing reminders",
  cancel_reminder: "Canceling reminder",
  collab_tool_call: "Collaborating",
};
const toolAliases: Readonly<Record<string, string>> = {
  read: "read_file",
  readfile: "read_file",
  file_read: "read_file",
  write: "write_file",
  writefile: "write_file",
  file_write: "write_file",
  edit: "edit_file",
  editfile: "edit_file",
  file_change: "edit_file",
  strreplacefile: "edit_file",
  apply_patch: "edit_file",
  shell: "bash",
  command_execution: "bash",
  run_shell_command: "bash",
  run_terminal_command: "bash",
  search_files: "glob",
  webfetch: "web_fetch",
  fetch_url: "web_fetch",
  fetchurl: "web_fetch",
  websearch: "web_search",
  searchweb: "web_search",
  todowrite: "todo_write",
  settodolist: "todo_write",
};
const legacyTools: Readonly<Record<string, string>> = {
  running_command: "bash",
  reading_file: "read_file",
  writing_file: "write_file",
  editing_file: "edit_file",
  using_tool: "tool",
};

/** Display-only projection: never derive Agent availability from these tones. */
export function presentActivity(observation: ActivityObservation): ActivityRow[] {
  const { detailKind: kind, level, detail } = observation;
  if (level !== "error") {
    const entries = observation.entries?.length
      ? observation.entries
      : legacyTools[kind]
        ? [{ kind: "tool_start" as const, toolName: legacyTools[kind] }]
        : [];
    if (entries.length)
      return entries.flatMap((entry): ActivityRow[] => {
        if (entry.kind === "tool_start") {
          const name = entry.toolName.replace(/^mcp__[^_]+__|^mcp_chat_/, "");
          const canonical = toolAliases[name.toLowerCase()] ?? name;
          if (canonical === "send_message") return [];
          const label = toolLabels[canonical] ?? name;
          return [
            {
              label,
              detail,
              recentLabel: label,
              currentLabel: toolLabels[canonical]
                ? `${label}…`
                : `Using ${name.length > 20 ? name.slice(0, 20) + "…" : name}…`,
              tone: "working",
              recentTone: "working",
              pulse: false,
              monospace: true,
              expandable: false,
              subagent: entry.subagent,
            },
          ];
        }
        const thinking = entry.kind === "thinking";
        return [
          {
            label: thinking ? "Thinking" : "Output",
            detail: entry.text,
            recentLabel: entry.text || (thinking ? "Thinking" : "Output"),
            currentLabel: thinking
              ? "Thinking…"
              : kind === "runtime_reconnecting"
                ? detail || "Working…"
                : "Working…",
            tone: thinking ? "thinking" : "output",
            recentTone: thinking ? "thinking" : "working",
            pulse: thinking,
            monospace: true,
            expandable: true,
            subagent: entry.subagent,
          },
        ];
      });
  }
  const tone: Tone =
    level === "error"
      ? "error"
      : observation.activityKind === "online"
        ? "idle"
        : (observation.activityKind ?? "unknown");
  const starting = tone === "working" && (kind === "starting" || kind === "runtime_starting");
  const label =
    tone === "error"
      ? "Error"
      : starting
        ? "Starting"
        : tone === "working"
          ? "Working"
          : tone === "thinking"
            ? "Thinking"
            : tone === "idle"
              ? "Idle"
              : tone === "offline"
                ? "Stopped"
                : "Activity";
  const recentLabel =
    tone === "working"
      ? starting
        ? "Starting…"
        : kind === "compacting_context"
          ? "Compacting context…"
          : detail || "Working…"
      : tone === "thinking"
        ? "Thinking…"
        : tone === "idle"
          ? "Online"
          : tone === "offline"
            ? "Stopped — won't receive messages until restarted"
            : tone === "error"
              ? detail
                ? `Error: ${detail}`
                : "Error"
              : detail || label;
  return [
    {
      label,
      detail: starting || (tone === "offline" && detail === "Stopped") ? "" : detail,
      recentLabel,
      currentLabel: tone === "working" || tone === "thinking" ? recentLabel : null,
      tone,
      recentTone: tone,
      pulse: tone === "working" || tone === "thinking",
      monospace: false,
      expandable: false,
    },
  ];
}

export function activityToneClass(tone: Tone) {
  switch (tone) {
    case "working":
    case "thinking":
      return "bg-amber-500";
    case "idle":
      return "bg-success-solid";
    case "error":
      return "bg-error-solid";
    case "output":
      return "bg-cyan-500";
    default:
      return "bg-offline";
  }
}

/** Format a cloud decision. No clocks, process facts or history reduction here. */
export function agentDisplay(display?: AgentDisplaySnapshot) {
  if (!display)
    return {
      kind: "unknown" as const,
      label: "Status unknown",
      isOnline: undefined,
      tone: "unknown" as const,
      pulse: false,
    };
  const kind = display.activityKind;
  const row = presentActivity({ ...display, level: kind === "error" ? "error" : "info" }).at(-1);
  const label =
    kind === "online"
      ? "Online"
      : kind === "offline"
        ? "Offline"
        : kind === "thinking"
          ? "Thinking…"
          : kind === "error"
            ? (row?.recentLabel ?? "Error")
            : (row?.currentLabel ?? "Working…");
  return {
    kind,
    label,
    isOnline: kind !== "offline",
    tone: kind === "online" ? ("idle" as const) : kind,
    pulse: kind === "working" || kind === "thinking",
  };
}
