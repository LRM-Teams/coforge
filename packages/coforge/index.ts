import {
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  isValidReactionEmoji,
  type AgentMessageRecord,
  type AgentReminderOperationResponse,
  type LocalReminderRequest,
  type TaskCommand,
  type TaskResult,
  type TaskStatus,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
  WEEKLY_REPORT_SUBJECT_TYPES,
} from "@lrm/coforge-sdk/internal";
import {
  createAgentApiClient,
  createMessageTransportAgentApiTransport,
} from "@lrm/coforge-sdk/agent";

export { createAgentApiClient } from "@lrm/coforge-sdk/agent";

export type MessageCommand = "check" | "read" | "search" | "send" | "resolve" | "react";
export type MessageSearchOptions = {
  query?: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
};
export type MessageInvocation =
  | { command: "check" }
  | {
      command: "read";
      target: string;
      before?: string;
      after?: string;
      around?: string;
      limit?: number;
    }
  | ({ command: "search" } & MessageSearchOptions)
  | {
      command: "send";
      target: string;
      sendDraft?: boolean;
      continueAnyway?: boolean;
      freshnessContextMode?: "withheld";
    }
  | { command: "resolve"; messageId: string }
  | { command: "react"; messageId: string; emoji: string; remove?: true };
export type AttachmentInvocation = {
  command: "attachment.view";
  attachmentId: string;
  output: string;
};
export type InboxInvocation = { command: "inbox-check" };
export type ChannelInvocation = { command: "mute" | "unmute"; target: string };
export type ReminderInvocation = Omit<LocalReminderRequest, "context" | "requestId"> & {
  command: "reminder";
};
export type ReminderTransportRequest = Omit<LocalReminderRequest, "context" | "requestId">;
export type LocalReminderReceiptResponse = {
  accepted: boolean;
  reminderId: string;
  revision: number;
};
export type ThreadInvocation = { command: "thread-unfollow"; target: string };
export type TaskInvocation = { command: "task"; task: Omit<TaskCommand, "requestId"> };
export type WorkspaceInfoOptions = {
  agents?: boolean;
  humans?: boolean;
  projects?: boolean;
  computers?: boolean;
  full?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};
export type WorkspaceInfoInvocation = { command: "workspace.info" } & WorkspaceInfoOptions;
export type WorkspaceInfoResult = WorkspaceInfoResponse & { computers?: unknown[] };
export type WeeklyReportInvocation = {
  command: "weekly-report";
  weeklyReport: WeeklyReportCommand;
};

export type MessageTransport = {
  check(): Promise<{ messages: AgentMessageRecord[]; hasMore?: boolean }>;
  read(
    target: string,
    options?: { before?: string; after?: string; around?: string; limit?: number },
  ): Promise<unknown>;
  search?(options: MessageSearchOptions): Promise<unknown>;
  send(
    target: string,
    body?: string,
    options?: {
      sendDraft?: boolean;
      continueAnyway?: boolean;
      freshnessContextMode?: "withheld";
    },
  ): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
  resolve?(messageId: string): Promise<unknown>;
  react?(messageId: string, emoji: string, remove?: boolean): Promise<unknown>;
  inboxCheck?(): Promise<unknown>;
  setChannelMuted?(target: string, muted: boolean): Promise<unknown>;
  reminder?(
    request: ReminderTransportRequest,
  ): Promise<AgentReminderOperationResponse | LocalReminderReceiptResponse>;
  setThreadFollowed?(target: string, followed: boolean): Promise<unknown>;
  task?(command: TaskCommand): Promise<TaskResult>;
  workspaceInfo?(): Promise<WorkspaceInfoResult>;
  weeklyReport?(command: WeeklyReportCommand): Promise<WeeklyReportResponse>;
};

/** Eight-hex-character prefix or a full UUID; the server stores ids lowercase. */
const MESSAGE_ANCHOR_PATTERN =
  /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(
  args: readonly string[],
):
  | MessageInvocation
  | AttachmentInvocation
  | InboxInvocation
  | ChannelInvocation
  | ReminderInvocation
  | ThreadInvocation
  | TaskInvocation
  | WorkspaceInfoInvocation
  | WeeklyReportInvocation {
  if (args[0] === "workspace" && args[1] === "info") return parseWorkspaceInfoArgs(args.slice(2));
  if (args[0] === "reminder") return parseReminderArgs(args.slice(1));
  if (args[0] === "task") return parseTaskArgs(args.slice(1));
  if (args[0] === "weekly-report") return parseWeeklyReportArgs(args.slice(1));
  if (
    args[0] === "channel" &&
    (args[1] === "mute" || args[1] === "unmute") &&
    args[2] === "--target" &&
    args.length === 4 &&
    /^#[a-z0-9][a-z0-9_-]{0,31}$/.test(args[3] ?? "")
  )
    return { command: args[1], target: args[3]! };
  if (
    args[0] === "thread" &&
    args[1] === "unfollow" &&
    args[2] === "--target" &&
    args.length === 4 &&
    /^#[a-z0-9][a-z0-9_-]{0,31}:(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
      args[3] ?? "",
    )
  )
    return { command: "thread-unfollow", target: args[3]! };
  if (args[0] === "inbox" && args[1] === "check" && args.length === 2)
    return { command: "inbox-check" };
  if (args[0] === "attachment" && args[1] === "view") {
    const attachmentId = args[2] === "--id" ? args[3] : undefined;
    const output = args[4] === "--output" ? args[5] : undefined;
    if (attachmentId && output && args.length === 6)
      return { command: "attachment.view", attachmentId, output };
  }
  if (args[0] === "message" && isMessageCommand(args[1])) {
    if (args[1] === "check" && args.length === 2) return { command: "check" };
    if (args[1] === "resolve") {
      const messageId = args[2];
      if (messageId && args.length === 3 && MESSAGE_ANCHOR_PATTERN.test(messageId))
        return { command: "resolve", messageId: messageId.toLowerCase() };
      throw new Error("Usage:");
    }
    if (args[1] === "react") {
      let messageId: string | undefined;
      let emoji: string | undefined;
      let remove = false;
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--message-id" && args[index + 1]) messageId = args[++index];
        else if (args[index] === "--emoji" && args[index + 1]) emoji = args[++index];
        else if (args[index] === "--remove") remove = true;
        else throw new Error("Usage:");
      }
      if (
        !messageId ||
        !emoji ||
        !MESSAGE_ANCHOR_PATTERN.test(messageId) ||
        !isValidReactionEmoji(emoji)
      )
        throw new Error("Usage:");
      return {
        command: "react",
        messageId: messageId.toLowerCase(),
        emoji,
        ...(remove ? { remove: true as const } : {}),
      };
    }
    if (args[1] === "search") {
      const options: MessageSearchOptions = {};
      for (let i = 2; i < args.length; i += 2) {
        const name = args[i];
        const value = args[i + 1];
        if (
          !name ||
          ![
            "--query",
            "--target",
            "--channel",
            "--sender",
            "--sort",
            "--before",
            "--after",
            "--limit",
            "--offset",
          ].includes(name) ||
          !value
        )
          throw new Error("Usage:");
        if (name === "--limit" || name === "--offset") {
          const number = Number(value);
          if (!Number.isInteger(number) || number < (name === "--limit" ? 1 : 0))
            throw new Error("Usage:");
          if (name === "--limit") options.limit = number;
          else options.offset = number;
        } else if (name === "--sort") {
          if (value !== "relevance" && value !== "recent") throw new Error("Usage:");
          options.sort = value;
        } else if (name === "--query") options.query = value.trim() || undefined;
        else if (name === "--target" || name === "--channel") {
          if (options.target && options.target !== value) throw new Error("Usage:");
          options.target = value;
        } else if (name === "--sender")
          options.sender = value.startsWith("@") ? value : `@${value}`;
        else if (name === "--before") options.before = value;
        else options.after = value;
      }
      if (!options.query && !options.target && !options.sender && !options.before && !options.after)
        throw new Error("Usage:");
      if (!options.query && options.sort === "relevance") throw new Error("Usage:");
      if (options.limit !== undefined && options.limit > 100) throw new Error("Usage:");
      return { command: "search", ...options };
    }
    if (args[1] === "read") {
      const target = args[2] === "--target" ? args[3] : undefined;
      const options: {
        before?: string;
        after?: string;
        around?: string;
        limit?: number;
      } = {};
      for (let i = 4; i < args.length; i += 2) {
        const name = args[i];
        const value = args[i + 1];
        if (!name || !["--before", "--after", "--around", "--limit"].includes(name) || !value)
          throw new Error("Usage:");
        if (name === "--limit") {
          const limit = Number(value);
          if (!Number.isInteger(limit)) throw new Error("Usage:");
          options.limit = limit;
        } else if (name === "--before") options.before = value;
        else if (name === "--after") options.after = value;
        else options.around = value;
      }
      const modes = [options.before, options.after, options.around].filter(Boolean);
      if (
        target &&
        modes.length <= 1 &&
        (options.limit === undefined || (options.limit >= 1 && options.limit <= 100))
      )
        return { command: "read", target, ...options } as MessageInvocation;
    } else if (args[1] === "send") {
      let target: string | undefined;
      let sendDraft = false;
      let continueAnyway = false;
      let reviewerIsolation = reviewerIsolationFromEnvironment();
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--target" && args[index + 1]) target = args[++index];
        else if (args[index] === "--send-draft") sendDraft = true;
        else if (args[index] === "--anyway") continueAnyway = true;
        else if (args[index] === "--reviewer-isolation") reviewerIsolation = true;
        else throw new Error("Usage:");
      }
      if (target && (!continueAnyway || sendDraft))
        return {
          command: "send",
          target,
          ...(sendDraft ? { sendDraft: true } : {}),
          ...(continueAnyway ? { continueAnyway: true } : {}),
          ...(reviewerIsolation ? { freshnessContextMode: "withheld" as const } : {}),
        };
    }
  }
  throw new Error(
    "Usage: coforge channel mute|unmute --target '#channel' | coforge thread unfollow --target '#channel:message-id' | coforge inbox check | coforge message check | coforge message search --query <text> [--target <target>] [--sender <handle>] [--sort relevance|recent] [--before <iso>] [--after <iso>] [--limit <n>] [--offset <n>] | coforge message read --target @user | coforge message send --target @user [--send-draft] [--anyway] [--reviewer-isolation] | coforge message resolve <message-id> | coforge message react --message-id <id> --emoji <emoji> [--remove] | coforge task list|create|convert|claim|unclaim|assign|update|amend|history|delete|receipt ... | coforge attachment view --id <id> --output <path> | coforge weekly-report context --subject-type report|highlight|cycle --subject-id <uuid> | coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>] | coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>]",
  );
}

function parseWorkspaceInfoArgs(args: readonly string[]): WorkspaceInfoInvocation {
  const result: WorkspaceInfoOptions = {};
  const flags = new Set([
    "--agents",
    "--humans",
    "--projects",
    "--computers",
    "--full",
    "--query",
    "--limit",
    "--offset",
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (
      !flag ||
      !flags.has(flag) ||
      (flag !== "--agents" &&
        flag !== "--humans" &&
        flag !== "--projects" &&
        flag !== "--full" &&
        !args[i + 1])
    )
      throw new Error(
        "Usage: coforge workspace info [--agents|--humans|--projects|--computers|--full] [--query <text>] [--limit <n>] [--offset <n>]",
      );
    if (flag === "--agents") result.agents = true;
    else if (flag === "--humans") result.humans = true;
    else if (flag === "--projects") result.projects = true;
    else if (flag === "--full") result.full = true;
    else if (flag === "--query") result.query = args[++i]!.trim() || undefined;
    else {
      const value = Number(args[++i]);
      if (
        !Number.isSafeInteger(value) ||
        (flag === "--limit" ? value < 1 || value > 100 : value < 0)
      )
        throw new Error(
          "Usage: coforge workspace info [--agents|--humans|--projects|--computers|--full] [--query <text>] [--limit <n>] [--offset <n>]",
        );
      if (flag === "--limit") result.limit = value;
      else result.offset = value;
    }
  }
  if (result.full && (result.agents || result.humans || result.projects || result.computers))
    throw new Error("Usage:");
  return { command: "workspace.info", ...result };
}

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  const invocation = parseArgs(args);
  if (invocation.command === "workspace.info") {
    const client = createAgentApiClient(createMessageTransportAgentApiTransport(transport));
    return formatWorkspaceInfo(await client.workspace.info(), invocation);
  }
  if (invocation.command === "reminder") {
    if (!transport.reminder) throw new Error("Reminder transport is unavailable");
    const { command: _command, ...request } = invocation;
    return formatReminderResponse(request.operation, await transport.reminder(request));
  }
  if (invocation.command === "task") {
    if (!transport.task) throw new Error("Task transport is unavailable");
    let command = { ...invocation.task, requestId: crypto.randomUUID() } as TaskCommand;
    if (
      (command.operation === "update" || command.operation === "unclaim") &&
      command.expectedRevision === undefined
    ) {
      const listed = await transport.task({
        operation: "list",
        requestId: crypto.randomUUID(),
        target: command.target,
      });
      const current = listed.tasks.find((task) => task.number === command.number);
      if (!current)
        throw new Error(`Task #${command.number} was not found; read the Task list again`);
      command = { ...command, expectedRevision: current.revision };
    }
    try {
      const result = await transport.task(command);
      const reviewerIsolation = command.freshnessContextMode === "withheld";
      if (command.operation === "history") return formatTaskHistory(result);
      if (command.operation === "receipt" && result.resourceFollowup)
        return `${formatTasks(result, reviewerIsolation)}\nFollow-up reminder=${result.resourceFollowup.id} owner=${result.resourceFollowup.owner} fireAt=${result.resourceFollowup.fireAt}`;
      return formatTasks(result, reviewerIsolation);
    } catch (error) {
      if (command.freshnessContextMode === "withheld")
        throw new Error("Reviewer-isolation Task request failed; upstream detail was withheld");
      if (error instanceof Error && /revision|conflict|stale/i.test(error.message))
        throw new Error("Task changed concurrently; read the Task list again before updating");
      throw error;
    }
  }
  if (invocation.command === "weekly-report") {
    if (!transport.weeklyReport) throw new Error("Weekly report transport is unavailable");
    return transport.weeklyReport(invocation.weeklyReport);
  }
  if (invocation.command === "mute" || invocation.command === "unmute") {
    if (!transport.setChannelMuted) throw new Error("Channel settings transport is unavailable");
    return transport.setChannelMuted(invocation.target, invocation.command === "mute");
  }
  if (invocation.command === "thread-unfollow") {
    if (!transport.setThreadFollowed) throw new Error("Thread settings transport is unavailable");
    return transport.setThreadFollowed(invocation.target, false);
  }
  if (invocation.command === "inbox-check") {
    if (!transport.inboxCheck) throw new Error("App Inbox transport is unavailable");
    return formatInboxCheck(await transport.inboxCheck());
  }
  if (invocation.command === "attachment.view") {
    const result = await transport.view(invocation.attachmentId);
    await Bun.write(invocation.output, result.bytes);
    return { attachmentId: invocation.attachmentId, path: invocation.output };
  }
  const { command } = invocation;
  if (command === "send") {
    try {
      const result = await transport.send(
        invocation.target,
        invocation.sendDraft ? undefined : await new Response(Bun.stdin.stream()).text(),
        {
          sendDraft: invocation.sendDraft,
          continueAnyway: invocation.continueAnyway,
          freshnessContextMode: invocation.freshnessContextMode,
        },
      );
      if (isHeldSend(result)) {
        if (invocation.freshnessContextMode === "withheld")
          throw reviewerIsolationHoldError(result);
        throw heldSendError(invocation.target);
      }
      return formatMessageRead(result);
    } catch (error) {
      if (
        invocation.freshnessContextMode === "withheld" &&
        !(error instanceof ReviewerIsolationHoldError)
      )
        throw new Error("Reviewer-isolation send failed; upstream response detail was withheld.");
      throw error;
    }
  }
  if (command === "search") {
    if (!transport.search) throw new Error("Message search transport is unavailable");
    const { command: _command, ...options } = invocation;
    return formatMessageRead(await transport.search(options));
  }
  if (command === "resolve") {
    if (!transport.resolve) throw new Error("Message resolve transport is unavailable");
    return formatMessageResolve(await transport.resolve(invocation.messageId));
  }
  if (command === "react") {
    if (!transport.react) throw new Error("Message reaction transport is unavailable");
    await transport.react(invocation.messageId, invocation.emoji, invocation.remove === true);
    return formatReaction(invocation.messageId, invocation.emoji, invocation.remove === true);
  }
  if (command === "check") return formatMessageCheck(await transport.check());
  return formatMessageRead(
    await transport.read(invocation.target, invocation.command === "read" ? invocation : undefined),
  );
}

function formatWorkspaceInfo(result: WorkspaceInfoResult, options: WorkspaceInfoOptions): string {
  const section = options.full
    ? "full"
    : options.agents
      ? "agents"
      : options.humans
        ? "humans"
        : options.projects
          ? "projects"
          : "summary";
  if (section === "summary")
    return `${result.workspace.name} (${result.workspace.slug})\nagents=${result.agents.length} humans=${result.humans.length} projects=${result.projects.length}`;
  const match = (value: unknown) =>
    !options.query || JSON.stringify(value).toLowerCase().includes(options.query.toLowerCase());
  const page = <T>(values: T[]) =>
    values.filter(match).slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  if (section === "agents")
    return (
      page(result.agents)
        .map(
          (agent) =>
            `${agent.displayName || agent.name} (@${agent.name}) status=${agent.status} role=${agent.role}`,
        )
        .join("\n") || "No workspace members."
    );
  if (section === "humans")
    return (
      page(result.humans)
        .map((human) => `${human.displayName || human.name} (@${human.name}) role=${human.role}`)
        .join("\n") || "No workspace humans."
    );
  if (section === "projects")
    return (
      page(result.projects)
        .map((p) => `${p.name} (${p.slug})${p.githubFullName ? ` github=${p.githubFullName}` : ""}`)
        .join("\n") || "No workspace projects."
    );
  return JSON.stringify(result);
}

function formatMessageCheck(result: { messages: AgentMessageRecord[]; hasMore?: boolean }): string {
  if (result.messages.length === 0) return "No new messages.";
  const footer = result.hasMore
    ? "More messages are pending. Run `coforge message check` again."
    : "No more new messages.";
  return `${result.messages.map(formatMessage).join("\n")}\n\n${footer}`;
}

function formatMessage(message: AgentMessageRecord): string {
  return `[target=${message.target} msg=${message.id.slice(0, 8)} time=${message.createdAt}] ${message.sender}: ${message.body}`;
}

function formatMessageResolve(result: unknown): string {
  const response = result as { messages?: AgentMessageRecord[] };
  const message = response.messages?.[0];
  if (!message) throw new Error("message not found or not visible to this Agent");
  return formatMessage(message);
}

function formatReaction(messageId: string, emoji: string, remove: boolean): string {
  const shortId = messageId.slice(0, 8);
  return `Reaction ${emoji} ${remove ? "removed from" : "added to"} message ${shortId}.`;
}

function formatMessageRead(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const response = result as { messages?: AgentMessageRecord[]; [key: string]: unknown };
  const { seenUpToSequence: _seenUpToSequence, ...withoutInternalCursor } = response;
  return JSON.stringify({
    ...withoutInternalCursor,
    ...(withoutInternalCursor.messages
      ? {
          messages: withoutInternalCursor.messages.map(
            ({ sequence: _sequence, ...message }) => message,
          ),
        }
      : {}),
  });
}

function isHeldSend(result: unknown): result is { accepted: false; sideEffectDecision: "hold" } {
  if (!result || typeof result !== "object") return false;
  const response = result as { accepted?: unknown; sideEffectDecision?: unknown };
  return response.accepted === false && response.sideEffectDecision === "hold";
}

function heldSendError(target: string): Error {
  return new Error(
    `Message was saved as a draft. Next commands: coforge message send --target "${target}" to replace/update it; coforge message send --target "${target}" --send-draft to send it unchanged; coforge message send --target "${target}" --send-draft --anyway as the escape hatch.`,
  );
}

class ReviewerIsolationHoldError extends Error {}

function reviewerIsolationHoldError(result: unknown): Error {
  const response = result as {
    newMessageCount?: unknown;
    withheldMessageCount?: unknown;
  };
  const count =
    typeof response.newMessageCount === "number"
      ? response.newMessageCount
      : typeof response.withheldMessageCount === "number"
        ? response.withheldMessageCount
        : 0;
  return new ReviewerIsolationHoldError(
    `Reviewer-isolation freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} withheld.`,
  );
}

function formatInboxCheck(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const response = result as { entries?: unknown[]; [key: string]: unknown };
  return JSON.stringify({
    ...response,
    ...(response.entries
      ? {
          entries: response.entries.map((entry) => {
            if (!entry || typeof entry !== "object") return entry;
            const value = entry as { messageTarget?: Record<string, unknown> };
            if (!value.messageTarget) return entry;
            const {
              firstPendingSequence: _first,
              latestSequence: _latest,
              ...messageTarget
            } = value.messageTarget;
            return { ...entry, messageTarget };
          }),
        }
      : {}),
  });
}

function isMessageCommand(value: string | undefined): value is MessageCommand {
  return (
    value === "check" ||
    value === "read" ||
    value === "search" ||
    value === "send" ||
    value === "resolve" ||
    value === "react"
  );
}

const REMINDER_USAGE =
  "Usage: coforge reminder schedule --title <title> --target <target> --message-id <full UUID|8hex> (--delay-seconds <n> | --fire-at <timestamp> | --repeat <rule>) [--repeat <rule>] [--tz <timezone>] | coforge reminder list (--all | --status scheduled|fired|canceled) | coforge reminder update --id <full UUID> [--title <title>] [--fire-at <timestamp>] [--repeat <rule|none>] [--tz <timezone>] | coforge reminder snooze --id <full UUID> (--delay-seconds <n> | --fire-at <timestamp>) | coforge reminder cancel|log --id <full UUID> | coforge reminder ack|dismiss --id <full UUID> --revision <n>";

function parseReminderArgs(args: readonly string[]): ReminderInvocation {
  const operation = args[0];
  if (
    !operation ||
    !["schedule", "list", "update", "snooze", "cancel", "log", "ack", "dismiss"].includes(operation)
  )
    throw new Error(REMINDER_USAGE);
  const names: Record<string, keyof ReminderTransportRequest> = {
    "--id": "reminderId",
    "--title": "title",
    "--target": "target",
    "--message-id": "messageId",
    "--delay-seconds": "delaySeconds",
    "--fire-at": "fireAt",
    "--repeat": "repeat",
    "--tz": "timezone",
    "--status": "status",
    "--revision": "revision",
  };
  const request: Record<string, unknown> = { command: "reminder", operation };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate reminder flag: ${flag}\n${REMINDER_USAGE}`);
    seen.add(flag);
    if (flag === "--all") {
      request.all = true;
      continue;
    }
    const field = names[flag];
    const value = args[++index];
    if (!field || value === undefined || value.startsWith("--"))
      throw new Error(`Unknown or incomplete reminder flag: ${flag}\n${REMINDER_USAGE}`);
    if (field === "delaySeconds" || field === "revision") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(REMINDER_USAGE);
      request[field] = number;
    } else request[field] = value;
  }
  if (
    typeof request.repeat === "string" &&
    request.repeat !== "none" &&
    request.timezone === undefined
  )
    request.timezone = "Asia/Shanghai";
  validateReminderShape(request as ReminderInvocation);
  decodeLocalReminderRequest(
    encodeLocalReminderRequest({
      ...request,
      requestId: "cli-validation",
      context: "cli-validation",
    } as LocalReminderRequest),
  );
  return request as ReminderInvocation;
}

function validateReminderShape(value: ReminderInvocation): void {
  const present = (field: keyof ReminderTransportRequest) => value[field] !== undefined;
  const allowed: Record<string, readonly (keyof ReminderTransportRequest)[]> = {
    schedule: ["title", "target", "messageId", "delaySeconds", "fireAt", "repeat", "timezone"],
    list: ["all", "status"],
    update: ["reminderId", "title", "fireAt", "repeat", "timezone"],
    snooze: ["reminderId", "delaySeconds", "fireAt"],
    cancel: ["reminderId"],
    log: ["reminderId"],
    ack: ["reminderId", "revision"],
    dismiss: ["reminderId", "revision"],
  };
  const fields = Object.keys(value).filter(
    (key) => key !== "command" && key !== "operation",
  ) as (keyof ReminderTransportRequest)[];
  if (fields.some((field) => !allowed[value.operation]!.includes(field)))
    throw new Error(REMINDER_USAGE);
  const id = value.reminderId;
  if (
    id !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error(`Invalid reminder ID; full UUID required.\n${REMINDER_USAGE}`);
  const timed = Number(present("delaySeconds")) + Number(present("fireAt"));
  if (
    value.operation === "schedule" &&
    (!value.title ||
      !value.target ||
      !value.messageId ||
      timed > 1 ||
      (!value.repeat && timed !== 1) ||
      value.repeat === "none")
  )
    throw new Error(REMINDER_USAGE);
  if (value.operation === "list" && Number(present("all")) + Number(present("status")) !== 1)
    throw new Error(REMINDER_USAGE);
  if (["cancel", "log"].includes(value.operation) && !id) throw new Error(REMINDER_USAGE);
  if (value.operation === "snooze" && (!id || timed !== 1)) throw new Error(REMINDER_USAGE);
  if (
    value.operation === "update" &&
    (!id ||
      ![value.title, value.fireAt, value.repeat, value.timezone].some((item) => item !== undefined))
  )
    throw new Error(REMINDER_USAGE);
  if (["ack", "dismiss"].includes(value.operation) && (!id || !value.revision))
    throw new Error(REMINDER_USAGE);
}

function formatReminderResponse(
  operation: string,
  result: AgentReminderOperationResponse | LocalReminderReceiptResponse,
): string {
  if (!result.accepted) return "Reminder request was not accepted.";
  if (operation === "ack" || operation === "dismiss") {
    const receipt = result as LocalReminderReceiptResponse;
    return `Accepted reminder ${operation} request: id=${receipt.reminderId} revision=${receipt.revision}.`;
  }
  const cloud = result as AgentReminderOperationResponse;
  if (operation === "list") {
    if (!cloud.reminders.length) return "No reminders found.";
    return cloud.reminders
      .map(
        (item) =>
          `id=${item.reminderId} revision=${item.version} status=${item.status} title=${JSON.stringify(item.title)} next=${item.fireAt} fired=${item.firedAt ?? "-"} time=${item.createdAt} repeat=${item.repeat ?? "none"} tz=${item.timezone ?? "-"} anchor=${item.messageId} target=${item.target}`,
      )
      .join("\n");
  }
  if (operation === "log") {
    if (!cloud.events.length) return "No reminder events found.";
    return cloud.events
      .map(
        (event) =>
          `event=${event.eventId} type=${event.type} time=${event.time} next=${event.nextFireAt ?? "-"}`,
      )
      .join("\n");
  }
  return `Accepted reminder ${operation} request.`;
}

const WEEKLY_REPORT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseWeeklyReportArgs(args: readonly string[]): WeeklyReportInvocation {
  const operation = args[0];
  if (operation !== "context" && operation !== "list" && operation !== "read")
    throw new Error("Usage:");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  if (operation === "context") {
    const subjectType = values.get("--subject-type");
    const subjectId = values.get("--subject-id");
    if (
      values.size !== 2 ||
      !WEEKLY_REPORT_SUBJECT_TYPES.includes(
        subjectType as (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number],
      ) ||
      !subjectId ||
      !WEEKLY_REPORT_UUID.test(subjectId)
    )
      throw new Error("Usage:");
    return {
      command: "weekly-report",
      weeklyReport: {
        operation: "context",
        subjectType: subjectType as (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number],
        subjectId,
      },
    };
  }
  if (operation === "list") {
    const cycleId = values.get("--cycle-id");
    const cursor = values.get("--cursor");
    const limitValue = values.get("--limit");
    for (const name of values.keys()) {
      if (name !== "--cycle-id" && name !== "--cursor" && name !== "--limit")
        throw new Error("Usage:");
    }
    if (cycleId && !WEEKLY_REPORT_UUID.test(cycleId)) throw new Error("Usage:");
    if (cursor && !WEEKLY_REPORT_UUID.test(cursor)) throw new Error("Usage:");
    let limit: number | undefined;
    if (limitValue) {
      limit = Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Usage:");
    }
    return {
      command: "weekly-report",
      weeklyReport: {
        operation: "list",
        ...(cycleId ? { cycleId } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  }
  const reportId = values.get("--report-id");
  const section = values.get("--section");
  const maxCharactersValue = values.get("--max-characters");
  for (const name of values.keys()) {
    if (name !== "--report-id" && name !== "--section" && name !== "--max-characters")
      throw new Error("Usage:");
  }
  if (!reportId || !WEEKLY_REPORT_UUID.test(reportId) || !section) throw new Error("Usage:");
  let maxCharacters: number | undefined;
  if (maxCharactersValue) {
    maxCharacters = Number(maxCharactersValue);
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 12_000)
      throw new Error("Usage:");
  }
  return {
    command: "weekly-report",
    weeklyReport: {
      operation: "read",
      reportId,
      section,
      ...(maxCharacters !== undefined ? { maxCharacters } : {}),
    },
  };
}

function parseTaskArgs(args: readonly string[]): TaskInvocation {
  const operation = args[0];
  if (
    !operation ||
    ![
      "list",
      "create",
      "convert",
      "claim",
      "unclaim",
      "assign",
      "update",
      "amend",
      "history",
      "delete",
      "receipt",
    ].includes(operation)
  )
    throw new Error("Usage:");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    if (name === "--clear-description" || name === "--reviewer-isolation") {
      if (values.has(name)) throw new Error("Usage:");
      values.set(name, "true");
      index -= 1;
      continue;
    }
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) throw new Error("Usage:");
    values.set(name, value);
  }
  const allowed: Record<string, string[]> = {
    list: ["--target", "--status"],
    create: ["--target", "--title", "--assignee"],
    convert: ["--target", "--message-id"],
    claim: ["--target", "--number", "--message-id", "--reviewer-isolation"],
    unclaim: ["--target", "--number", "--expected-revision"],
    assign: ["--target", "--number", "--assignee", "--expected-revision"],
    update: ["--target", "--number", "--status", "--expected-revision", "--reviewer-isolation"],
    amend: [
      "--target",
      "--number",
      "--title",
      "--description",
      "--clear-description",
      "--expected-revision",
      "--reviewer-isolation",
    ],
    history: ["--target", "--number"],
    delete: ["--target", "--number", "--expected-revision"],
    receipt: [
      "--target",
      "--number",
      "--expected-revision",
      "--object",
      "--purpose",
      "--teardown-owner",
      "--security-privacy",
      "--expiry",
      "--runbook",
      "--tracking",
    ],
  };
  if ([...values.keys()].some((key) => !allowed[operation]!.includes(key)))
    throw new Error("Usage:");
  if (values.has("--description") && values.has("--clear-description"))
    throw new Error("Use either --description or --clear-description, not both");
  const target = values.get("--target");
  if (!target || !/^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,31})$/.test(target))
    throw new Error("Usage:");
  const number = integerOption(values.get("--number"), 1);
  const expectedRevision = integerOption(values.get("--expected-revision"), 0);
  const status = values.get("--status") as TaskStatus | undefined;
  if (status && !["todo", "in_progress", "in_review", "done", "closed"].includes(status))
    throw new Error("Usage:");
  let receipt: TaskCommand["receipt"];
  if (operation === "receipt") {
    const required = (flag: string) => {
      const value = values.get(flag)?.trim();
      if (!value) throw new Error(`${flag} is required and must be nonblank`);
      return value;
    };
    const teardownOwner = required("--teardown-owner");
    if (!/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(teardownOwner))
      throw new Error("--teardown-owner must be an @agent handle");
    const expiry = new Date(required("--expiry"));
    if (!Number.isFinite(expiry.getTime()))
      throw new Error("--expiry must be an ISO-8601 timestamp");
    receipt = {
      object: required("--object"),
      purpose: required("--purpose"),
      teardownOwner,
      securityPrivacy: required("--security-privacy"),
      expiry: expiry.toISOString(),
      runbook: required("--runbook"),
      tracking: required("--tracking"),
    };
  }
  const reviewerIsolation =
    ["claim", "update", "amend"].includes(operation) &&
    (values.has("--reviewer-isolation") || reviewerIsolationFromEnvironment());
  const task = {
    operation,
    target,
    number,
    messageId: values.get("--message-id"),
    title: values.get("--title"),
    description: values.get("--description"),
    assignee: values.get("--assignee"),
    ...(values.has("--clear-description") ? { description: null } : {}),
    status,
    expectedRevision,
    ...(receipt ? { receipt } : {}),
    ...(reviewerIsolation ? { freshnessContextMode: "withheld" as const } : {}),
  } as Omit<TaskCommand, "requestId">;
  const valid =
    operation === "list" ||
    (operation === "create" &&
      Boolean(task.title) &&
      (!task.assignee || /^@[a-z0-9][a-z0-9_-]{0,31}$/.test(task.assignee))) ||
    (operation === "convert" && Boolean(task.messageId)) ||
    (operation === "claim" && (number !== undefined) !== Boolean(task.messageId)) ||
    (operation === "unclaim" && number !== undefined) ||
    (operation === "assign" && number !== undefined && Boolean(task.assignee)) ||
    (operation === "update" && number !== undefined && Boolean(status)) ||
    (operation === "amend" &&
      number !== undefined &&
      (Boolean(task.title) || task.description !== undefined)) ||
    (["history", "delete", "receipt"].includes(operation) && number !== undefined);
  if (!valid) throw new Error("Usage:");
  return { command: "task", task };
}

function integerOption(value: string | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error("Usage:");
  return parsed;
}

function formatTasks(result: TaskResult, reviewerIsolation = false): string {
  if (result.state === "held") {
    if (reviewerIsolation || result.freshnessContextMode === "withheld") {
      const count = result.newMessageCount ?? result.withheldMessageCount ?? 0;
      return `Reviewer-isolation freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} withheld.`;
    }
    const messages = result.heldMessages?.map(formatMessage).join("\n");
    return `Task request held.${messages ? ` Review newer messages:\n${messages}` : ""}`;
  }
  if (!result.tasks.length) return "No tasks.";
  return result.tasks
    .map(
      (task) =>
        `#${task.number} status=${task.status} owner=${task.owner?.name ?? "unclaimed"} message=${task.messageId} revision=${task.revision} ${task.title}`,
    )
    .join("\n");
}

function formatTaskHistory(result: TaskResult): string {
  if (!result.history?.length) return "No task history.";
  return result.history
    .map(
      (event) =>
        `${event.sequence} ${event.eventType} actor=${event.actorName ?? event.actorKind} at=${event.createdAt}`,
    )
    .join("\n");
}

function reviewerIsolationFromEnvironment(): boolean {
  const value = Bun.env.COFORGE_REVIEWER_ISOLATION;
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("COFORGE_REVIEWER_ISOLATION must be one of: 1, true, 0, false");
}
