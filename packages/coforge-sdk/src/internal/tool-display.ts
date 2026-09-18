/**
 * Shared tool display vocabulary for the Daemon (the Activity `detail` a `tool_start`
 * frame carries — an always-safe generic label, never a command or path) and the Web
 * client (tool row labels in the Activity timeline, popover and current-status header).
 * One alias table, one label table, one label formula: a raw provider tool name never
 * needs translating twice, and the two sides cannot drift apart.
 */

// Every alias a provider is known to send for a canonical tool name, lowercase. A
// canonical name also maps to itself, so a lookup never needs an `?? name` fallback to
// recognize a name it already knows.
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: "read_file",
  readfile: "read_file",
  file_read: "read_file",
  read_file: "read_file",
  write: "write_file",
  writefile: "write_file",
  file_write: "write_file",
  write_file: "write_file",
  edit: "edit_file",
  editfile: "edit_file",
  file_change: "edit_file",
  strreplacefile: "edit_file",
  apply_patch: "edit_file",
  edit_file: "edit_file",
  bash: "bash",
  shell: "bash",
  command_execution: "bash",
  run_shell_command: "bash",
  run_terminal_command: "bash",
  glob: "glob",
  search_files: "glob",
  grep: "grep",
  web_fetch: "web_fetch",
  webfetch: "web_fetch",
  fetch_url: "web_fetch",
  fetchurl: "web_fetch",
  web_search: "web_search",
  websearch: "web_search",
  searchweb: "web_search",
  todo_write: "todo_write",
  todowrite: "todo_write",
  settodolist: "todo_write",
};

// One human label per canonical tool, no trailing ellipsis. A caller that needs the
// "…"-suffixed busy/current-status form uses `toolActivityLabel` below instead.
export const TOOL_LABELS: Readonly<Record<string, string>> = {
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

/**
 * Strips an MCP-style prefix (`mcp__<server>__` or `mcp_chat_`) and resolves what is
 * left through `TOOL_ALIASES`, case-insensitively. Returns both the stripped display
 * name (original case — an unknown tool's label is built from this) and the resolved
 * canonical name (the `TOOL_LABELS` lookup key).
 */
export function canonicalToolName(rawName: string): { canonical: string; name: string } {
  const name = rawName.replace(/^mcp__[^_]+__|^mcp_chat_/, "");
  const canonical = TOOL_ALIASES[name.toLowerCase()] ?? name;
  return { canonical, name };
}

/**
 * The generic, always-safe "…"-suffixed label a `tool_start` Activity's `detail`
 * carries: a known canonical tool's label, or `Using <name>…` for a tool this table
 * does not recognize (the name itself capped at 20 characters, so an unusually long
 * or adversarial tool name cannot become the leak). Never derived from tool
 * arguments — the argument summary belongs in the entry's `toolInput` instead.
 */
export function toolActivityLabel(rawName: string): string {
  const { canonical, name } = canonicalToolName(rawName);
  const label = TOOL_LABELS[canonical];
  return label ? `${label}…` : `Using ${name.length > 20 ? `${name.slice(0, 20)}…` : name}…`;
}

const GENERATED_TOOL_LABELS: ReadonlySet<string> = new Set(
  Object.values(TOOL_LABELS).map((label) => `${label}…`),
);

/**
 * Whether `text` is exactly a label `toolActivityLabel` could have produced — a known
 * tool's label or the unknown-tool "Using …" shape — as opposed to an arbitrary
 * daemon-supplied string (a raw command, path or argument). Lets a display fallback
 * recognize an already-generic label an up-to-date daemon sent, so it is kept as is;
 * it is a recognizer, not a sanitizer, and never applied to Activity before display.
 */
export function isToolActivityLabel(text: string): boolean {
  return GENERATED_TOOL_LABELS.has(text) || /^Using .+…$/.test(text);
}
