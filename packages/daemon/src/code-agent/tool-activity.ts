import {
  AGENT_ACTIVITY_DETAIL_KIND,
  TOOL_ALIASES,
  toolActivityLabel,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";
import { redactTrajectoryText } from "../agent-runtime/activity-trajectory";
import { createAgentActivity } from "../agent-runtime/agent-activity";

// `TOOL_ALIASES` (shared with the web tool row labels — see
// `packages/coforge-sdk/src/internal/tool-display.ts`) resolves a provider's tool name
// to the canonical name this module allowlists an argument summary for. Keys are
// lowercase; do not infer an operation by inspecting arbitrary args.

// A canonical tool's summary is built from exactly one allowlisted argument
// field; every other tool (including "bash", handled separately, and any
// unrecognized canonical name) reports its name only.
const SUMMARY_KIND: Readonly<Record<string, "file_path" | "pattern" | "url" | "query">> = {
  read_file: "file_path",
  write_file: "file_path",
  edit_file: "file_path",
  glob: "pattern",
  grep: "pattern",
  web_fetch: "url",
  web_search: "query",
};

// CoForge CLI subcommand -> canonical tool + allowlisted summary. Applies
// only when the tokenised `bash` command's first token is `coforge` or a
// path ending in `/coforge`.
const TASK_TOOLS: Readonly<Record<string, string>> = {
  list: "list_tasks",
  create: "create_task",
  convert: "convert_task",
  claim: "claim_tasks",
  unclaim: "unclaim_task",
  assign: "assign_task",
  update: "update_task_status",
  amend: "amend_task",
  history: "task_history",
  delete: "delete_task",
  receipt: "task_receipt",
};
const REMINDER_TOOLS: Readonly<Record<string, string>> = {
  schedule: "schedule_reminder",
  list: "list_reminders",
  update: "update_reminder",
  snooze: "snooze_reminder",
  cancel: "cancel_reminder",
  log: "reminder_log",
  ack: "ack_reminder",
  dismiss: "dismiss_reminder",
};

export function toolActivity(name: string, args: unknown, occurredAt?: string) {
  const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const canonical = TOOL_ALIASES[name.toLowerCase()] ?? name;

  if (canonical === "bash") {
    const bash = summarizeBash(input.command);
    return buildActivity(bash.detailKind, bash.summary, bash.toolName, occurredAt);
  }

  const kind = SUMMARY_KIND[canonical];
  const summary =
    kind === "file_path"
      ? allowlistedString(input.file_path ?? input.path, 200)
      : kind === "pattern"
        ? allowlistedString(input.pattern ?? input.query, 120)
        : kind === "url"
          ? allowlistedString(input.url, 200)
          : kind === "query"
            ? allowlistedString(input.query, 120)
            : undefined;
  return buildActivity(AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED, summary, canonical, occurredAt);
}

/**
 * `detail` is always the generic, argument-free label (`toolActivityLabel`) — never
 * the command, path or other summary — so the Agent status header can never leak one
 * (see `docs/observability.md`). The summary itself, when there is one, travels only
 * in the entry's `toolInput`, sanitized to satisfy the SDK's `validToolInput` (at most
 * 200 code points, no control characters).
 */
function buildActivity(
  detailKind: AgentActivityDetailKind,
  summary: string | undefined,
  toolName: string,
  occurredAt?: string,
) {
  const result = createAgentActivity(detailKind, "info", toolActivityLabel(toolName), occurredAt);
  const toolInput = summary ? sanitizeToolInput(summary) : undefined;
  return {
    ...result,
    entries: [
      {
        kind: "tool_start" as const,
        toolName: sanitizeToolName(toolName),
        ...(toolInput ? { toolInput } : {}),
      },
    ],
  };
}

// Collapses control characters (including newlines) to a space, then collapses
// runs of whitespace and trims, so a multi-line or otherwise-invalid summary still
// satisfies the SDK's `validToolInput` instead of failing to decode on the wire.
function sanitizeToolInput(value: string): string {
  const collapsed = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return [...collapsed].slice(0, 200).join("");
}

function summarizeBash(command: unknown): {
  detailKind: AgentActivityDetailKind;
  summary: string | undefined;
  toolName: string;
} {
  if (typeof command !== "string")
    return {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
      summary: undefined,
      toolName: "bash",
    };
  const tokens = tokenizeShellCommand(command);
  const first = tokens[0];
  if (tokens.length > 1 && first !== undefined && isCoforgeInvocation(first)) {
    const invocation = resolveCoforgeInvocation(tokens);
    return {
      detailKind: invocation.checkingMessages
        ? AGENT_ACTIVITY_DETAIL_KIND.CHECKING_MESSAGES
        : AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
      summary: invocation.summary,
      toolName: invocation.tool,
    };
  }
  // Never let a heredoc body (or anything after it) reach the Activity
  // detail; cut before redacting and truncating to the first 100 Unicode
  // characters, matching the trajectory redaction.
  const beforeHeredoc = command.split("<<")[0] ?? "";
  const redacted = redactTrajectoryText(beforeHeredoc);
  return {
    detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
    summary: [...redacted].slice(0, 100).join("").trimEnd(),
    toolName: "bash",
  };
}

function isCoforgeInvocation(token: string): boolean {
  return token === "coforge" || token.endsWith("/coforge");
}

type CoforgeInvocation = { tool: string; summary?: string; checkingMessages?: boolean };

function resolveCoforgeInvocation(tokens: readonly string[]): CoforgeInvocation {
  const category = tokens[1];
  const sub = tokens[2];
  if (category === "message" && sub !== undefined) {
    if (sub === "send") return { tool: "send_message", summary: flagValue(tokens, "--target") };
    if (sub === "check") return { tool: "check_messages", checkingMessages: true };
    if (sub === "read") return { tool: "read_history", summary: flagValue(tokens, "--target") };
    if (sub === "search")
      return {
        tool: "search_messages",
        summary: allowlistedString(flagValue(tokens, "--query"), 120),
      };
    if (sub === "resolve") return { tool: "resolve_message" };
    if (sub === "react") return { tool: "react_message" };
  } else if (category === "inbox" && sub === "check") {
    return { tool: "check_inbox", checkingMessages: true };
  } else if (category === "channel" && (sub === "mute" || sub === "unmute")) {
    return {
      tool: sub === "mute" ? "mute_channel" : "unmute_channel",
      summary: flagValue(tokens, "--target"),
    };
  } else if (category === "thread" && sub === "unfollow") {
    return { tool: "unfollow_thread", summary: flagValue(tokens, "--target") };
  } else if (category === "task" && sub !== undefined && Object.hasOwn(TASK_TOOLS, sub)) {
    const target = flagValue(tokens, "--target");
    const number = flagValue(tokens, "--number");
    return {
      tool: TASK_TOOLS[sub]!,
      summary: target ? (number ? `${target} #${number}` : target) : undefined,
    };
  } else if (category === "attachment" && sub === "view") {
    return { tool: "view_file" };
  } else if (category === "reminder" && sub !== undefined && Object.hasOwn(REMINDER_TOOLS, sub)) {
    if (sub === "schedule")
      return {
        tool: "schedule_reminder",
        summary: allowlistedString(flagValue(tokens, "--title"), 40),
      };
    if (sub === "list") return { tool: "list_reminders" };
    const id = flagValue(tokens, "--id");
    return { tool: REMINDER_TOOLS[sub]!, summary: id ? [...id].slice(0, 8).join("") : undefined };
  } else if (category === "weekly-report") {
    return { tool: "weekly_report" };
  } else if (category === "manual" && (sub === "get" || sub === "search")) {
    return {
      tool: sub === "get" ? "get_manual" : "search_manual",
      summary: allowlistedString(tokens[3], 120),
    };
  } else if (category === "whoami") {
    // Deliberately local (ADR 0036): no wire call, so it is always read-only, unconditionally.
    return { tool: "whoami" };
  } else if (category === "version") {
    return { tool: "get_version" };
  } else if (category === "user" && sub === "info") {
    return { tool: "get_user_info", summary: allowlistedString(tokens[3], 60) };
  } else if (category === "profile" && sub === "show") {
    const target = tokens[3] && !tokens[3].startsWith("--") ? tokens[3] : undefined;
    return { tool: "get_profile", summary: allowlistedString(target, 60) };
  } else if (category === "profile" && sub === "update") {
    return { tool: "update_profile" };
  }
  return { tool: "coforge_cli" };
}

function flagValue(tokens: readonly string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

// Splits a shell command line into argv-like tokens, honouring single/double
// quoting and backslash escapes. Stops at the first unquoted `<<`, `|`, `;`,
// `&&`, `||`, or newline so a heredoc body, pipeline or command chain never
// reaches the returned tokens.
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  const push = () => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "\n") break;
    if (ch === " " || ch === "\t") {
      push();
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      push();
      break;
    }
    if (ch === "|" && command[i + 1] === "|") {
      push();
      break;
    }
    if (ch === "&" && command[i + 1] === "&") {
      push();
      break;
    }
    if (ch === "|" || ch === ";") {
      push();
      break;
    }
    if (ch === "'") {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) {
          current += command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      inToken = true;
      current += command[i + 1];
      i += 2;
      continue;
    }
    inToken = true;
    current += ch;
    i++;
  }
  push();
  return tokens;
}

function allowlistedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

function sanitizeToolName(name: string): string {
  return [...name.replace(/[\x00-\x1f\x7f]/g, "")].slice(0, 128).join("") || "unknown";
}
