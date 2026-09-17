import {
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  isReminderId,
  isValidReactionEmoji,
  mentionsInContent,
  parseMentionSelector,
  type AgentMessageRecord,
  type AgentReminderOperationResponse,
  type ChannelCommand,
  type LocalReminderRequest,
  type MentionSelectorInput as MentionSelector,
  type ReminderSummaryRecord,
  type TaskCommand,
  type TaskResult,
  type TaskStatus,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
  WEEKLY_REPORT_SUBJECT_TYPES,
} from "@lrm/coforge-sdk/internal";
import { parseDurationSeconds } from "./src/reminder-duration";
import {
  createAgentApiClient,
  createMessageTransportAgentApiTransport,
  type ActionCardAction,
  type GitHubCredentialResponse,
} from "@lrm/coforge-sdk/agent";
import { parseActionCardInput, toActionCardAction } from "./src/action-prepare-input";
import {
  formatAttachmentDownloadSuccess,
  formatAttachmentUploadSuccess,
  formatHeldSend,
  formatMessageLine,
  formatReadWindow,
  formatSearchResults,
  formatSendSuccess,
} from "./src/message-format";
import {
  formatChannelAddMember,
  formatChannelArchive,
  formatChannelCreate,
  formatChannelInfo,
  formatChannelJoin,
  formatChannelLeave,
  formatChannelMembers,
  formatChannelRemoveMember,
  formatChannelUpdate,
} from "./src/channel-format";
import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
  withOutputMode,
} from "./src/cli-error";
import { attachmentMimeType, validateAttachmentUploadArgs } from "./src/attachment-upload";

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
      json?: boolean;
      attachmentId?: string;
      mentions?: MentionSelector[];
      targetConfirmed?: boolean;
    }
  | { command: "resolve"; messageId: string }
  | { command: "react"; messageId: string; emoji: string; remove?: true };
export type AttachmentInvocation = {
  command: "attachment.view";
  attachmentId: string;
  output: string;
  json?: boolean;
};
export type AttachmentUploadInvocation = {
  command: "attachment.upload";
  path?: string;
  target?: string;
  mimeType?: string;
  json?: boolean;
};
export type InboxInvocation = { command: "inbox-check" };
export type ChannelInvocation = { command: "mute" | "unmute"; target: string };
/** `channel info|members|join|leave|create|update|lifecycle|add-member|remove-member`, disjoint
 * from `ChannelInvocation` above (`mute`/`unmute`, unchanged). */
export type ChannelManagementInvocation = {
  command: "channel-manage";
  channel: Omit<ChannelCommand, "requestId">;
  json?: boolean;
};
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
export type ActionPrepareInvocation = { command: "action-prepare"; target: string };
export type ActionPrepareResult = { messageId?: string; metadata?: { kind: string } };

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
      attachmentId?: string;
      mentions?: MentionSelector[];
      targetConfirmed?: boolean;
    },
  ): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
  upload?(input: {
    path: string;
    target: string;
    mimeType?: string;
  }): Promise<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
  resolve?(messageId: string): Promise<unknown>;
  react?(messageId: string, emoji: string, remove?: boolean): Promise<unknown>;
  inboxCheck?(): Promise<unknown>;
  setChannelMuted?(target: string, muted: boolean): Promise<unknown>;
  reminder?(
    request: ReminderTransportRequest,
  ): Promise<AgentReminderOperationResponse | LocalReminderReceiptResponse>;
  setThreadFollowed?(target: string, followed: boolean): Promise<unknown>;
  channel?(command: Omit<ChannelCommand, "requestId">): Promise<unknown>;
  task?(command: TaskCommand): Promise<TaskResult>;
  workspaceInfo?(): Promise<WorkspaceInfoResult>;
  weeklyReport?(command: WeeklyReportCommand): Promise<WeeklyReportResponse>;
  githubCredential?(): Promise<GitHubCredentialResponse>;
  actionPrepare?(target: string, action: ActionCardAction): Promise<ActionPrepareResult>;
};

/** Eight-hex-character prefix or a full UUID; the server stores ids lowercase. */
const MESSAGE_ANCHOR_PATTERN =
  /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A full UUID; `--attachment-id` never accepts an eight-hex short form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(
  args: readonly string[],
):
  | MessageInvocation
  | AttachmentInvocation
  | AttachmentUploadInvocation
  | InboxInvocation
  | ChannelInvocation
  | ChannelManagementInvocation
  | ReminderInvocation
  | ThreadInvocation
  | TaskInvocation
  | WorkspaceInfoInvocation
  | WeeklyReportInvocation
  | ActionPrepareInvocation {
  if (args[0] === "workspace" && args[1] === "info") return parseWorkspaceInfoArgs(args.slice(2));
  if (args[0] === "reminder") return parseReminderArgs(args.slice(1));
  if (args[0] === "task") return parseTaskArgs(args.slice(1));
  if (args[0] === "weekly-report") return parseWeeklyReportArgs(args.slice(1));
  if (args[0] === "action" && args[1] === "prepare") return parseActionPrepareArgs(args.slice(2));
  if (
    args[0] === "channel" &&
    (args[1] === "mute" || args[1] === "unmute") &&
    args[2] === "--target" &&
    args.length === 4 &&
    /^#[a-z0-9][a-z0-9_-]{0,31}$/.test(args[3] ?? "")
  )
    return { command: args[1], target: args[3]! };
  if (args[0] === "channel" && args[1] !== undefined && args[1] !== "mute" && args[1] !== "unmute")
    return parseChannelManagementArgs(args.slice(1));
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
    let positionalId: string | undefined;
    let explicitId: string | undefined;
    let output: string | undefined;
    let json = false;
    let index = 2;
    // A positional id (`coforge attachment view <id> --output <path>`), as Raft accepts, in
    // addition to `--id <id>`.
    if (
      args[index] !== undefined &&
      args[index] !== "--id" &&
      args[index] !== "--output" &&
      args[index] !== "--json"
    ) {
      positionalId = args[index];
      index++;
    }
    for (; index < args.length; index++) {
      if (args[index] === "--id" && args[index + 1]) explicitId = args[++index];
      else if (args[index] === "--output" && args[index + 1]) output = args[++index];
      else if (args[index] === "--json") json = true;
      else throw new Error("Usage:");
    }
    // Raft's `validateViewOpts`: the same three preconditions, same codes and messages.
    if (positionalId && explicitId)
      throw new CliError({
        code: "INVALID_ARG",
        message: "pass the attachment id either positionally or with --id, not both",
        retryable: false,
      });
    const attachmentId = positionalId || explicitId;
    if (!attachmentId)
      throw new CliError({
        code: "INVALID_ARG",
        message: "attachment id is required (pass <attachmentId> or --id)",
        retryable: false,
      });
    if (!output)
      throw new CliError({
        code: "INVALID_ARG",
        message: "--output is required",
        retryable: false,
      });
    return {
      command: "attachment.view",
      attachmentId,
      output,
      ...(json ? { json: true as const } : {}),
    };
  }
  if (args[0] === "attachment" && args[1] === "upload") {
    let path: string | undefined;
    let target: string | undefined;
    // Legacy alias for --target (Raft's transition alias); giving both is a usage error.
    let channelAlias: string | undefined;
    let mimeType: string | undefined;
    let json = false;
    for (let index = 2; index < args.length; index++) {
      if (args[index] === "--path" && args[index + 1]) path = args[++index];
      else if (args[index] === "--target" && args[index + 1]) target = args[++index];
      else if (args[index] === "--channel" && args[index + 1]) channelAlias = args[++index];
      else if (args[index] === "--mime-type" && args[index + 1]) mimeType = args[++index];
      else if (args[index] === "--json") json = true;
      else throw new Error("Usage:");
    }
    if (target !== undefined && channelAlias !== undefined) throw new Error("Usage:");
    return {
      command: "attachment.upload",
      path,
      target: target ?? channelAlias,
      mimeType,
      ...(json ? { json: true as const } : {}),
    };
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
      let json = false;
      let reviewerIsolation = reviewerIsolationFromEnvironment();
      let attachmentId: string | undefined;
      let attachmentIdSeen = false;
      const rawMentions: string[] = [];
      let targetConfirmed = false;
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--target" && args[index + 1]) target = args[++index];
        else if (args[index] === "--send-draft") sendDraft = true;
        else if (args[index] === "--anyway") continueAnyway = true;
        else if (args[index] === "--reviewer-isolation") reviewerIsolation = true;
        else if (args[index] === "--json") json = true;
        else if (args[index] === "--target-confirmed") targetConfirmed = true;
        else if (args[index] === "--attachment-id" && args[index + 1]) {
          if (attachmentIdSeen) throw new Error("Usage:");
          attachmentIdSeen = true;
          attachmentId = args[++index];
        } else if (args[index] === "--mention" && args[index + 1]) rawMentions.push(args[++index]!);
        else throw new Error("Usage:");
      }
      const outputMode = json ? "json" : "text";
      if (attachmentId !== undefined && !UUID_PATTERN.test(attachmentId))
        throw withOutputMode(
          new CliError({
            code: "INVALID_ARG",
            message: "--attachment-id must be a full attachment UUID.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      if (attachmentId !== undefined && sendDraft)
        throw withOutputMode(
          new CliError({
            code: "INVALID_ARG",
            message:
              "--attachment-id cannot be used with --send-draft. Use a normal send to replace the draft.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      const mentions = rawMentions.length
        ? parseMentionSelectors(rawMentions, outputMode)
        : undefined;
      if (target && (!continueAnyway || sendDraft))
        return {
          command: "send",
          target,
          ...(sendDraft ? { sendDraft: true } : {}),
          ...(continueAnyway ? { continueAnyway: true } : {}),
          ...(reviewerIsolation ? { freshnessContextMode: "withheld" as const } : {}),
          ...(json ? { json: true as const } : {}),
          ...(attachmentId !== undefined ? { attachmentId } : {}),
          ...(mentions ? { mentions } : {}),
          ...(targetConfirmed ? { targetConfirmed: true } : {}),
        };
    }
  }
  throw new Error(
    "Usage: coforge channel mute|unmute --target '#channel' | coforge channel info <target> | coforge channel members <target> | coforge channel join --target '#channel' | coforge channel leave --target '#channel' | coforge channel create --name <name> [--description <text>] [--json] | coforge channel update --target '#channel' [--name <name>] [--description <text>] [--json] | coforge channel lifecycle archive|unarchive --target '#channel' [--json] | coforge channel add-member --target '#channel' (--user @handle | --agent @handle) [--json] | coforge channel remove-member --target '#channel' (--user @handle | --agent @handle) [--json] | coforge thread unfollow --target '#channel:message-id' | coforge inbox check | coforge message check | coforge message search --query <text> [--target <target>] [--sender <handle>] [--sort relevance|recent] [--before <iso>] [--after <iso>] [--limit <n>] [--offset <n>] | coforge message read --target @user | coforge message send --target @user [--send-draft] [--anyway] [--reviewer-isolation] [--json] [--attachment-id <uuid>] [--mention human:<uuid>:<handle>|agent:<uuid>:<handle>]... [--target-confirmed] | coforge message resolve <message-id> | coforge message react --message-id <id> --emoji <emoji> [--remove] | coforge task list|create|convert|claim|unclaim|assign|unassign|update|amend|history|delete|receipt ... | coforge attachment view [--id] <id> --output <path> [--json] | coforge attachment upload --path <file> (--target <target>|--channel <target>) [--mime-type <type>] [--json] | coforge weekly-report context --subject-type report|highlight|cycle --subject-id <uuid> | coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>] | coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>] | coforge action prepare --target <target>",
  );
}

/**
 * Validates each `--mention` value's shape and rejects a handle bound to two different actors in
 * the same message. Duplicate identical bindings (same handle, same actor) collapse to one entry.
 * Whether each bound handle actually appears in the message body is checked separately in `run()`,
 * once the body is known.
 */
function parseMentionSelectors(
  raw: readonly string[],
  outputMode: "text" | "json",
): MentionSelector[] {
  const byHandle = new Map<string, MentionSelector>();
  const result: MentionSelector[] = [];
  for (const value of raw) {
    const parsed = parseMentionSelector(value);
    if (!parsed)
      throw withOutputMode(
        new CliError({
          code: "INVALID_MENTION_SELECTOR",
          message: "--mention must be human:<actor-uuid>:<handle> or agent:<actor-uuid>:<handle>.",
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    const existing = byHandle.get(parsed.name);
    if (existing && (existing.type !== parsed.type || existing.id !== parsed.id))
      throw withOutputMode(
        new CliError({
          code: "MENTION_BINDING_CONFLICT",
          message: `@${parsed.name} cannot be bound to more than one actor in the same message.`,
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    if (!existing) {
      byHandle.set(parsed.name, parsed);
      result.push(parsed);
    }
  }
  return result;
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

const CHANNEL_MANAGEMENT_BOOLEAN_FLAGS = new Set(["--private", "--public", "--json"]);

/** Rejects `--private`/`--public`, which Raft accepts but CoForge does not; every channel is
 * public and there is no private/visibility column (see ADR 0024). */
function privateChannelsUnsupportedError(): CliError {
  return new CliError({
    code: "UNSUPPORTED",
    message: "private channels are not supported in CoForge; every channel is public.",
    retryable: false,
  });
}

/** Raft's `parseRegularChannelTarget`, applied the same way Raft applies it: to `join`, `leave`,
 * `update`, `lifecycle archive|unarchive`, `add-member`, and `remove-member` — never to `info`/
 * `members` (which accept a wider target grammar) or `create` (which has no target at all).
 * Rejects a thread target, an `@user` DM, or a bare name with no leading `#`. */
function requireRegularChannelTarget(target: string): string {
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target))
    throw new CliError({
      code: "INVALID_TARGET",
      message:
        "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      retryable: false,
    });
  return target;
}

/** Generic `--flag value` / `--boolean-flag` parser shared by the `channel` subcommands below. */
function parseChannelFlags(
  args: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name || !allowed.includes(name) || values.has(name)) throw new Error("Usage:");
    if (CHANNEL_MANAGEMENT_BOOLEAN_FLAGS.has(name)) {
      values.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error("Usage:");
    values.set(name, value);
  }
  return values;
}

/**
 * `channel info|members|join|leave|create|update|lifecycle archive|unarchive|add-member|
 * remove-member`. `mute`/`unmute` are parsed separately, above, and unchanged.
 */
function parseChannelManagementArgs(args: readonly string[]): ChannelManagementInvocation {
  const sub = args[0];
  if (sub === "info" || sub === "members") {
    const target = args[1];
    if (!target || args.length !== 2) throw new Error("Usage:");
    return { command: "channel-manage", channel: { operation: sub, target } };
  }
  if (sub === "lifecycle") {
    const action = args[1];
    if (action !== "archive" && action !== "unarchive") throw new Error("Usage:");
    const values = parseChannelFlags(args.slice(2), ["--target", "--json"]);
    const target = values.get("--target");
    if (!target) throw new Error("Usage:");
    return {
      command: "channel-manage",
      channel: { operation: action, target: requireRegularChannelTarget(target) },
      json: values.has("--json"),
    };
  }
  if (sub === "join" || sub === "leave") {
    const values = parseChannelFlags(args.slice(1), ["--target", "--json"]);
    const target = values.get("--target");
    if (!target) throw new Error("Usage:");
    return {
      command: "channel-manage",
      channel: { operation: sub, target: requireRegularChannelTarget(target) },
      json: values.has("--json"),
    };
  }
  if (sub === "create") {
    const values = parseChannelFlags(args.slice(1), [
      "--name",
      "--description",
      "--private",
      "--json",
    ]);
    if (values.has("--private")) throw privateChannelsUnsupportedError();
    const name = values.get("--name");
    if (!name) throw new Error("Usage:");
    return {
      command: "channel-manage",
      channel: { operation: "create", name, description: values.get("--description") },
      json: values.has("--json"),
    };
  }
  if (sub === "update") {
    const values = parseChannelFlags(args.slice(1), [
      "--target",
      "--name",
      "--description",
      "--public",
      "--private",
      "--json",
    ]);
    if (values.has("--private") || values.has("--public")) throw privateChannelsUnsupportedError();
    const target = values.get("--target");
    if (!target) throw new Error("Usage:");
    const name = values.get("--name");
    const description = values.get("--description");
    if (name === undefined && description === undefined) throw new Error("Usage:");
    return {
      command: "channel-manage",
      channel: {
        operation: "update",
        target: requireRegularChannelTarget(target),
        name,
        description,
      },
      json: values.has("--json"),
    };
  }
  if (sub === "add-member" || sub === "remove-member") {
    const values = parseChannelFlags(args.slice(1), ["--target", "--user", "--agent", "--json"]);
    const target = values.get("--target");
    const user = values.get("--user");
    const agent = values.get("--agent");
    if (!target || (user === undefined) === (agent === undefined)) throw new Error("Usage:");
    return {
      command: "channel-manage",
      channel: { operation: sub, target: requireRegularChannelTarget(target), user, agent },
      json: values.has("--json"),
    };
  }
  throw new Error("Usage:");
}

function parseActionPrepareArgs(args: readonly string[]): ActionPrepareInvocation {
  let target: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--target" && args[index + 1]) target = args[++index];
    else
      throw new CliError({
        code: "INVALID_ARG",
        message: "Usage: coforge action prepare --target <target>",
        retryable: false,
      });
  }
  if (!target?.trim())
    throw new CliError({ code: "INVALID_ARG", message: "--target is required", retryable: false });
  return { command: "action-prepare", target };
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
    const resolved = await resolveReminderRequestId(transport, request);
    return formatReminderResponse(resolved.operation, await transport.reminder(resolved));
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
  if (invocation.command === "action-prepare") {
    if (!transport.actionPrepare) throw new Error("Action transport is unavailable");
    const raw = await new Response(Bun.stdin.stream()).text();
    const action = toActionCardAction(parseActionCardInput(raw));
    const result = await transport.actionPrepare(invocation.target, action);
    if (!result.messageId)
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Prepare action response did not include a message id",
        retryable: false,
      });
    const shortId = result.messageId.slice(0, 8);
    return `Action card posted to ${invocation.target} as message ${result.messageId} (short ${shortId}). The human can click the action verb to commit.`;
  }
  if (invocation.command === "mute" || invocation.command === "unmute") {
    if (!transport.setChannelMuted) throw new Error("Channel settings transport is unavailable");
    return transport.setChannelMuted(invocation.target, invocation.command === "mute");
  }
  if (invocation.command === "channel-manage") {
    if (!transport.channel) throw new Error("Channel management transport is unavailable");
    const { channel } = invocation;
    const response = (await transport.channel(channel)) as Record<string, unknown>;
    if (invocation.json) return response;
    switch (channel.operation) {
      case "info":
        return formatChannelInfo(response as Parameters<typeof formatChannelInfo>[0]);
      case "members":
        return formatChannelMembers(response as Parameters<typeof formatChannelMembers>[0]);
      case "join":
        return formatChannelJoin(response as Parameters<typeof formatChannelJoin>[0]);
      case "leave":
        return formatChannelLeave(response as Parameters<typeof formatChannelLeave>[0]);
      case "create":
        return formatChannelCreate(response as Parameters<typeof formatChannelCreate>[0]);
      case "update":
        return formatChannelUpdate(response as Parameters<typeof formatChannelUpdate>[0]);
      case "archive":
      case "unarchive":
        return formatChannelArchive(response as Parameters<typeof formatChannelArchive>[0]);
      case "add-member":
        return formatChannelAddMember(response as Parameters<typeof formatChannelAddMember>[0]);
      case "remove-member": {
        const removeResponse = response as { wasMember: boolean };
        return formatChannelRemoveMember(
          channel.target!,
          (channel.user ?? channel.agent)!,
          removeResponse.wasMember,
        );
      }
    }
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
    if (invocation.json)
      return JSON.stringify({ attachmentId: invocation.attachmentId, path: invocation.output });
    return formatAttachmentDownloadSuccess(invocation.output);
  }
  if (invocation.command === "attachment.upload") {
    if (!transport.upload) throw new Error("Attachment upload transport is unavailable");
    const { path, target } = await validateAttachmentUploadArgs(invocation);
    const mimeType = attachmentMimeType(path, invocation.mimeType);
    const result = await transport.upload({ path, target, mimeType });
    if (invocation.json) return JSON.stringify(result);
    return formatAttachmentUploadSuccess(result);
  }
  const { command } = invocation;
  if (command === "send") {
    const outputMode = invocation.json ? "json" : "text";
    const body = invocation.sendDraft ? undefined : await new Response(Bun.stdin.stream()).text();
    // With `--send-draft`, the body (and thus content presence) is only known to the daemon, which
    // already re-sends the draft's own saved mentions when no explicit override is given.
    if (invocation.mentions?.length && body !== undefined) {
      const present = mentionsInContent(body);
      for (const mention of invocation.mentions)
        if (!present.has(mention.name))
          throw withOutputMode(
            new CliError({
              code: "MENTION_NOT_IN_CONTENT",
              message: `Structured mention @${mention.name} is not present in the message body.`,
              retryable: false,
              draftSaved: false,
              suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
            }),
            outputMode,
          );
    }
    let result: unknown;
    try {
      result = await transport.send(invocation.target, body, {
        sendDraft: invocation.sendDraft,
        continueAnyway: invocation.continueAnyway,
        freshnessContextMode: invocation.freshnessContextMode,
        attachmentId: invocation.attachmentId,
        mentions: invocation.mentions,
        targetConfirmed: invocation.targetConfirmed,
      });
    } catch (error) {
      // The transport (`local-client.ts`) already redacts upstream detail for a withheld request;
      // this fallback only covers a transport that throws a bare `Error` without going through it.
      if (invocation.freshnessContextMode === "withheld" && !(error instanceof CliError))
        throw withOutputMode(
          new CliError({
            code: "SEND_FAILED",
            message: "Reviewer-isolation send failed; upstream response detail was withheld.",
            retryable: false,
            draftSaved: true,
            suggestedNextAction: unknownDeliveryNextAction(invocation.target),
          }),
          outputMode,
        );
      throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
    }
    if (isHeldSend(result))
      throw withOutputMode(
        heldSendCliError(
          invocation.target,
          result as {
            attentionCount?: number;
            anywayAllowed?: boolean;
            messages?: AgentMessageRecord[];
          },
          invocation.freshnessContextMode === "withheld",
        ),
        outputMode,
      );
    const sent = result as { messageId?: string; recentUnread?: AgentMessageRecord[] };
    if (invocation.json)
      return JSON.stringify({
        state: "sent",
        target: invocation.target,
        messageId: sent.messageId,
        recentUnread: sent.recentUnread ?? [],
      });
    return formatSendSuccess(invocation.target, sent as { messageId: string }, sent.recentUnread);
  }
  if (command === "search") {
    if (!transport.search) throw new Error("Message search transport is unavailable");
    const { command: _command, ...options } = invocation;
    const response = (await transport.search(options)) as { messages: AgentMessageRecord[] };
    return formatSearchResults(options.query ?? "", response);
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
  const readOptions = invocation.command === "read" ? invocation : undefined;
  const readResponse = (await transport.read(invocation.target, readOptions)) as {
    messages: AgentMessageRecord[];
    hasOlder?: boolean;
    hasNewer?: boolean;
  };
  return formatReadWindow(invocation.target, readResponse, { around: readOptions?.around });
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
  return formatMessageLine(message);
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

function isHeldSend(result: unknown): result is { accepted: false; sideEffectDecision: "hold" } {
  if (!result || typeof result !== "object") return false;
  const response = result as { accepted?: unknown; sideEffectDecision?: unknown };
  return response.accepted === false && response.sideEffectDecision === "hold";
}

const HELD_SEND_NEXT_ACTION =
  "Review the held context, then update the draft or send the current draft unchanged.";

/**
 * A hold is not a transport failure — the server made a definite decision and the daemon already
 * saved the reply as a local draft — but it is still not delivery, so `message send` reports it as
 * a typed error rather than a quiet success. Reviewer isolation keeps withholding message content;
 * the ordinary case keeps printing the existing rich held-context report (`formatHeldSend`).
 */
function heldSendCliError(
  target: string,
  result: { attentionCount?: number; anywayAllowed?: boolean; messages?: AgentMessageRecord[] },
  reviewerIsolation: boolean,
): CliError {
  if (reviewerIsolation) {
    const response = result as { newMessageCount?: unknown; withheldMessageCount?: unknown };
    const count =
      typeof response.newMessageCount === "number"
        ? response.newMessageCount
        : typeof response.withheldMessageCount === "number"
          ? response.withheldMessageCount
          : 0;
    return new CliError({
      code: "SEND_HELD_AS_DRAFT",
      message: `Reviewer-isolation freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} withheld.`,
      retryable: false,
      effect: "draft_saved",
      draftSaved: true,
      suggestedNextAction: HELD_SEND_NEXT_ACTION,
    });
  }
  return new CliError({
    code: "SEND_HELD_AS_DRAFT",
    message: "Message held as draft; no target delivery occurred.",
    retryable: false,
    effect: "draft_saved",
    draftSaved: true,
    contextText: formatHeldSend(target, result),
    suggestedNextAction: HELD_SEND_NEXT_ACTION,
  });
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
  "Usage: coforge reminder schedule --title <title> (--target <target>|--channel <target>) (--message-id <full UUID|8hex>|--msg-id <full UUID|8hex>) (--delay-seconds <n|duration> | --fire-at <timestamp> | --repeat <rule>) [--repeat <rule>] [--tz <timezone>] | coforge reminder list [--all | --status <comma-list of scheduled,fired,canceled; default scheduled,fired>] | coforge reminder update --id <full UUID|8hex+> (--fire-at <timestamp> | --in <duration> | --repeat <rule|none>|--cadence <rule|none> | --title <title>) [--tz <timezone>] | coforge reminder snooze --id <full UUID|8hex+> (--delay-seconds <n|duration> | --by <duration> | --fire-at <timestamp>) | coforge reminder cancel|log --id <full UUID|8hex+> | coforge reminder ack|dismiss --id <full UUID|8hex+> --revision <n>";

/** A resolvable `--id` is a full UUID or a case-insensitive hex prefix of at least 8 characters. */
const REMINDER_ID_PREFIX = /^[0-9a-f]{8,}$/i;

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
    "--channel": "target",
    "--message-id": "messageId",
    "--msg-id": "messageId",
    "--delay-seconds": "delaySeconds",
    "--fire-at": "fireAt",
    "--repeat": "repeat",
    "--cadence": "repeat",
    "--tz": "timezone",
    "--status": "status",
    "--revision": "revision",
  };
  const request: Record<string, unknown> = { command: "reminder", operation };
  const seen = new Set<string>();
  // Tracks which literal flag last claimed each logical field, so an alias used together with its
  // canonical spelling (or with another alias of the same field) is a usage error even though the
  // two flags are spelled differently and so never collide in `seen`.
  const flagForField = new Map<string, string>();
  const claimField = (field: string, flag: string) => {
    const existing = flagForField.get(field);
    if (existing !== undefined && existing !== flag)
      throw new Error(`Cannot combine ${flag} with ${existing}.\n${REMINDER_USAGE}`);
    flagForField.set(field, flag);
  };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate reminder flag: ${flag}\n${REMINDER_USAGE}`);
    seen.add(flag);
    if (flag === "--all") {
      request.all = true;
      continue;
    }
    if (flag === "--by" || flag === "--in") {
      // Both are duration spellings of the same wire field, `delaySeconds`: `--by` on snooze and
      // `--in` on update. Neither computes an absolute `fireAt` locally — the daemon/server derive
      // the due time from `delaySeconds` exactly as they already do for snooze.
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`Unknown or incomplete reminder flag: ${flag}\n${REMINDER_USAGE}`);
      const seconds = parseDurationSeconds(value);
      if (seconds === null)
        throw new Error(`Invalid duration for ${flag}: '${value}'.\n${REMINDER_USAGE}`);
      claimField("delaySeconds", flag);
      request.delaySeconds = seconds;
      continue;
    }
    const field = names[flag];
    const value = args[++index];
    if (!field || value === undefined || value.startsWith("--"))
      throw new Error(`Unknown or incomplete reminder flag: ${flag}\n${REMINDER_USAGE}`);
    claimField(field, flag);
    if (field === "delaySeconds") {
      const integer = Number(value);
      const seconds =
        Number.isSafeInteger(integer) && integer >= 1 ? integer : parseDurationSeconds(value);
      if (seconds === null) throw new Error(REMINDER_USAGE);
      request[field] = seconds;
    } else if (field === "revision") {
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
  // The wire-level round trip below requires a full UUID for `reminderId` (the daemon and server
  // never see a bare prefix — it is resolved to a full ID before the real request goes out; see
  // `resolveReminderRequestId`). Substitute a throwaway, well-formed UUID so this local check still
  // validates every other field early; the substitution is discarded and never sent anywhere.
  const rawId = request.reminderId as string | undefined;
  const needsIdProbe = rawId !== undefined && !isReminderId(rawId);
  decodeLocalReminderRequest(
    encodeLocalReminderRequest({
      ...request,
      ...(needsIdProbe ? { reminderId: "12345678-1234-4123-8123-123456789abc" } : {}),
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
    update: ["reminderId", "title", "fireAt", "delaySeconds", "repeat", "timezone"],
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
  if (id !== undefined && !isReminderId(id) && !REMINDER_ID_PREFIX.test(id))
    throw new Error(
      `Invalid reminder ID; full UUID or an id prefix of at least 8 hex characters required.\n${REMINDER_USAGE}`,
    );
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
  // Raft's `list` defaults to scheduled,fired when neither `--all` nor `--status` is given
  // (the server already applies that default); only passing both together is a usage error.
  if (value.operation === "list" && present("all") && present("status"))
    throw new Error(REMINDER_USAGE);
  if (["cancel", "log"].includes(value.operation) && !id) throw new Error(REMINDER_USAGE);
  if (value.operation === "snooze" && (!id || timed !== 1)) throw new Error(REMINDER_USAGE);
  if (value.operation === "update") {
    if (!id || timed > 1) throw new Error(REMINDER_USAGE);
    // Raft: "Pass exactly one of --fire-at, --in, --cadence, or --title" (code INVALID_ARG).
    // --fire-at and --in both land in `timed` (the time mutation), so they count as one slot.
    const mutations = [timed === 1, value.repeat !== undefined, value.title !== undefined].filter(
      Boolean,
    ).length;
    if (mutations !== 1)
      throw new Error(
        `Pass exactly one of --fire-at, --in, --cadence, or --title.\n${REMINDER_USAGE}`,
      );
    if (value.timezone !== undefined && value.repeat === undefined)
      throw new Error(
        `--tz may only accompany a cadence change (--cadence/--repeat).\n${REMINDER_USAGE}`,
      );
  }
  if (["ack", "dismiss"].includes(value.operation) && (!id || !value.revision))
    throw new Error(REMINDER_USAGE);
}

/** The `list` scope an `--id` prefix lookup runs under, matching Raft's per-command scoping. */
export type ReminderIdResolutionScope = { all: true } | { statuses: readonly string[] };

/**
 * Reminder operations that take `--id`, and the `list` scope each resolves a short prefix within.
 * `cancel`/`snooze` only ever act on an active reminder, so they resolve within scheduled/fired,
 * same as Raft. `update`, `log`, `ack`, and `dismiss` can target any status (Raft's `update` passes
 * `all: true`; `log` doesn't resolve client-side at all in Raft, but our wire protocol always
 * requires a full UUID, so we resolve unscoped — the "if it resolves with all, use all" case).
 */
const REMINDER_ID_RESOLUTION_SCOPE: Record<string, ReminderIdResolutionScope> = {
  cancel: { statuses: ["scheduled", "fired"] },
  snooze: { statuses: ["scheduled", "fired"] },
  update: { all: true },
  log: { all: true },
  ack: { all: true },
  dismiss: { all: true },
};

/**
 * Resolves `request.reminderId` to a full UUID when it is a short prefix, leaving every other
 * request untouched. A full UUID never triggers the lookup (the brief's "skip the lookup" case).
 */
async function resolveReminderRequestId(
  transport: Pick<MessageTransport, "reminder">,
  request: ReminderTransportRequest,
): Promise<ReminderTransportRequest> {
  const scope = REMINDER_ID_RESOLUTION_SCOPE[request.operation];
  if (!scope || !request.reminderId) return request;
  if (isReminderId(request.reminderId)) return request;
  return {
    ...request,
    reminderId: await resolveReminderId(transport, request.reminderId, scope),
  };
}

/**
 * Resolves an `--id` prefix (at least 8 hex characters, case-insensitive) to the one full reminder
 * ID it matches, by listing reminders within `scope` and comparing prefixes against each id with
 * its formatting dashes stripped. Takes the transport directly (rather than reaching for the
 * ambient one) so it is unit-testable with a fake transport.
 */
export async function resolveReminderId(
  transport: Pick<MessageTransport, "reminder">,
  prefix: string,
  scope: ReminderIdResolutionScope = { all: true },
): Promise<string> {
  if (!transport.reminder) throw new Error("Reminder transport is unavailable");
  const response = (await transport.reminder(
    "all" in scope
      ? { operation: "list", all: true }
      : { operation: "list", status: scope.statuses.join(",") },
  )) as AgentReminderOperationResponse;
  const lowerPrefix = prefix.toLowerCase();
  const matches = (response.reminders ?? []).filter((item: ReminderSummaryRecord) =>
    item.reminderId.replace(/-/g, "").toLowerCase().startsWith(lowerPrefix),
  );
  // Mirrors Raft's `resolveReminderId`: an unscoped ("all") lookup just says "reminder"; a
  // status-scoped lookup names the scope, e.g. "scheduled/fired reminder".
  const scopeLabel = "all" in scope ? "reminder" : `${scope.statuses.join("/")} reminder`;
  if (matches.length === 0)
    throw new CliError({
      code: "NOT_FOUND",
      message: `No ${scopeLabel} matches id prefix '${prefix}'.`,
      retryable: false,
    });
  if (matches.length > 1)
    throw new CliError({
      code: "AMBIGUOUS",
      message: `Ambiguous id prefix '${prefix}' matches ${matches.length} reminders; pass a longer id.`,
      retryable: false,
    });
  return matches[0]!.reminderId;
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
      "unassign",
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
    unassign: ["--target", "--number", "--expected-revision"],
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
    (operation === "unassign" && number !== undefined) ||
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
