import {
  DEFAULT_REMINDER_TIMEZONE,
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  UUID_LIKE_PATTERN,
  isReminderId,
  isValidReactionEmoji,
  mentionsInContent,
  parseMentionSelector,
  RFC_UUID_PATTERN,
  type AgentMessageRecord,
  type AgentReminderOperationResponse,
  type ChannelCommand,
  type LocalReminderRequest,
  type MentionSelectorInput as MentionSelector,
  type ReminderSummaryRecord,
  type TaskCommand,
  type TaskHistoryEvent,
  type TaskResourceReceipt,
  type TaskResult,
  type TaskStatus,
  TASK_STATUSES,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
  type WeeklyReportResponse,
  WEEKLY_REPORT_SUBJECT_TYPES,
} from "@lrm/coforge-sdk/internal";
import { parseDurationSeconds } from "#src/reminder-duration";
import {
  createAgentApiClient,
  createMessageTransportAgentApiTransport,
  type ActionCardAction,
  type AgentManualGetResponse,
  type AgentManualSearchResponse,
  type AgentVersionResponse,
  type AgentProfileShowResponse,
  type AgentProfileUpdateRequest,
  type AgentProfileUpdateResponse,
  type AgentUserInfoResponse,
  type AgentMentionActionKind,
  type AgentMentionExecuteRequest,
  type AgentMentionExecuteResponse,
  type AgentMentionPendingResponse,
  type GitHubCredentialResponse,
  type WorkspaceInfoRuntimeContext,
} from "@lrm/coforge-sdk/agent";
import { COFORGE_CLI_VERSION } from "#src/version";
import { formatManualGet, formatManualSearchResults } from "#src/manual-format";
import { formatProfile, formatUserInfo } from "#src/user-format";
import {
  formatMentionActionResults,
  formatPendingMentionActions,
  incompleteMentionActions,
} from "#src/mention-format";
import { parseActionCardInput, toActionCardAction } from "#src/action-prepare-input";
import {
  formatAttachmentDownloadSuccess,
  formatAttachmentUploadSuccess,
  formatHeldSend,
  formatMessageLine,
  formatReadWindow,
  formatSearchResults,
  formatSendSuccess,
  formatTaskWorkflowHint,
  formatUndeliveredMentions,
  senderPendingMention,
  senderUnresolvedMention,
  type PendingMentionAction,
} from "#src/message-format";
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
} from "#src/channel-format";
import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
  withOutputMode,
} from "#src/cli-error";
import { attachmentMimeType, validateAttachmentUploadArgs } from "#src/attachment-upload";
import {
  claimRefusal,
  formatClaimResults,
  formatMyTaskList,
  formatResourceReceiptRecorded,
  formatTaskAmended,
  formatTaskAssigned,
  formatTaskBoard,
  formatTaskConverted,
  formatTaskDeleted,
  formatTaskStatusUpdated,
  formatTaskUnclaimed,
  formatTasksCreated,
} from "#src/task-format";

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
  | { command: "check"; target?: string }
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
      attachmentIds?: string[];
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
export type TaskInvocation = { command: "task"; task: Omit<TaskCommand, "idempotencyKey"> };
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
/** `whoami`'s view: the shared shape minus the key our HTTP names `idempotencyKey` (the Agent API's
 * own `workspace_info` result carries that name, not `requestId`). */
export type WorkspaceInfoResult = Omit<WorkspaceInfoResponse, "requestId"> & {
  /** The Agent API's own name for the request id it echoes (the local hop carries `requestId`). */
  idempotencyKey: string;
  computers?: unknown[];
};
export type WeeklyReportInvocation = {
  command: "weekly-report";
  weeklyReport: WeeklyReportCommand;
};
export type WeeklyReportCollectCommand = {
  requestId: string;
  runId: string;
  outcome: "ready" | "empty" | "failed";
  packMarkdown?: string;
  failureReason?: string;
};
export type WeeklyReportCollectResult = {
  requestId: string;
  runId: string;
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
};
export type WeeklyReportCollectInvocation = {
  command: "weekly-report-collect";
  collect: WeeklyReportCollectCommand;
  /** When set, `run` loads this file into `collect.packMarkdown` before posting. */
  markdownPath?: string;
};
export type WeeklyReportKeyPointsCommand = {
  requestId: string;
  reportId: string;
  markdown: string;
};
export type WeeklyReportKeyPointsResult = {
  requestId: string;
  reportId: string;
  status: string;
};
export type WeeklyReportKeyPointsInvocation = {
  command: "weekly-report-key-points";
  keyPoints: WeeklyReportKeyPointsCommand;
  /** When set, `run` loads this file into `keyPoints.markdown` before posting. */
  markdownPath?: string;
};
export type ActionPrepareInvocation = { command: "action-prepare"; target: string };
export type ActionPrepareResult = { messageId?: string; metadata?: { kind: string } };
export type ManualInvocation =
  | { command: "manual-get"; topic: string; intent: string; reason: string }
  | { command: "manual-search"; query: string; intent: string; reason: string };
export type WhoamiInvocation = { command: "whoami"; json?: boolean };
export type VersionInvocation = { command: "version"; json?: boolean };
export type UserInfoInvocation = { command: "user-info"; name: string; json?: boolean };
export type ProfileShowInvocation = {
  command: "profile-show";
  target?: string;
  json?: boolean;
};
export type MentionInvocation =
  | { command: "mention-pending"; json?: boolean }
  | {
      command: "mention-action";
      action: AgentMentionActionKind;
      resolutionIds: string[];
      json?: boolean;
    };
export type ProfileUpdateInvocation = {
  command: "profile-update";
  displayName?: string;
  description?: string;
  json?: boolean;
};

export type MessageTransport = {
  check(target?: string): Promise<{ messages: AgentMessageRecord[]; hasMore?: boolean }>;
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
      attachmentIds?: string[];
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
  weeklyReportCollect?(command: WeeklyReportCollectCommand): Promise<WeeklyReportCollectResult>;
  weeklyReportKeyPoints?(
    command: WeeklyReportKeyPointsCommand,
  ): Promise<WeeklyReportKeyPointsResult>;
  githubCredential?(): Promise<GitHubCredentialResponse>;
  /** Server-decided `Co-authored-by` trailers for `coforge git prepare-commit-msg`; never built by
   * the CLI itself. */
  githubCommitTrailers?(repository: string | null): Promise<string[]>;
  actionPrepare?(target: string, action: ActionCardAction): Promise<ActionPrepareResult>;
  manualGet?(topic: string, intent: string, reason: string): Promise<AgentManualGetResponse>;
  manualSearch?(query: string, intent: string, reason: string): Promise<AgentManualSearchResponse>;
  /** `coforge version`'s local-only Daemon query; never reaches Web/backend. */
  version?(): Promise<AgentVersionResponse>;
  userInfo?(name: string): Promise<AgentUserInfoResponse>;
  profileShow?(target?: string): Promise<AgentProfileShowResponse>;
  profileUpdate?(input: AgentProfileUpdateRequest): Promise<AgentProfileUpdateResponse>;
  /** The calling Agent's mentions that reached no one (`coforge mention pending`). */
  mentionPending?(): Promise<AgentMentionPendingResponse>;
  /** Acts on pending mentions by resolution id (`coforge mention notify|add`). */
  mentionExecute?(request: AgentMentionExecuteRequest): Promise<AgentMentionExecuteResponse>;
};

/** Eight-hex-character prefix or a full UUID; the server stores ids lowercase. */
const MESSAGE_ANCHOR_PATTERN =
  /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A full UUID; `--attachment-id` never accepts an eight-hex short form. */
const UUID_PATTERN = UUID_LIKE_PATTERN;

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
  | WeeklyReportCollectInvocation
  | WeeklyReportKeyPointsInvocation
  | ActionPrepareInvocation
  | ManualInvocation
  | WhoamiInvocation
  | VersionInvocation
  | UserInfoInvocation
  | ProfileShowInvocation
  | ProfileUpdateInvocation
  | MentionInvocation {
  if (args[0] === "whoami") return parseWhoamiArgs(args.slice(1));
  if (args[0] === "version") return parseVersionArgs(args.slice(1));
  if (args[0] === "manual" && (args[1] === "get" || args[1] === "search"))
    return parseManualArgs(args.slice(1));
  if (args[0] === "user" && args[1] === "info") return parseUserInfoArgs(args.slice(2));
  if (args[0] === "profile" && args[1] === "show") return parseProfileShowArgs(args.slice(2));
  if (args[0] === "profile" && args[1] === "update") return parseProfileUpdateArgs(args.slice(2));
  if (args[0] === "workspace" && args[1] === "info") return parseWorkspaceInfoArgs(args.slice(2));
  if (args[0] === "mention") return parseMentionArgs(args.slice(1));
  if (args[0] === "reminder") return parseReminderArgs(args.slice(1));
  if (args[0] === "task") return parseTaskArgs(args.slice(1));
  if (args[0] === "weekly-report-collect") return parseWeeklyReportCollectArgs(args.slice(1));
  if (args[0] === "weekly-report-key-points") return parseWeeklyReportKeyPointsArgs(args.slice(1));
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
    if (args[1] === "check") {
      if (args.length === 2) return { command: "check" };
      if (args[2] === "--target" && args[3] && args.length === 4)
        return { command: "check", target: args[3] };
    }
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
      const rawAttachmentIds: string[] = [];
      const rawMentions: string[] = [];
      let targetConfirmed = false;
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--target" && args[index + 1]) target = args[++index];
        else if (args[index] === "--send-draft") sendDraft = true;
        else if (args[index] === "--anyway") continueAnyway = true;
        else if (args[index] === "--reviewer-isolation") reviewerIsolation = true;
        else if (args[index] === "--json") json = true;
        else if (args[index] === "--target-confirmed") targetConfirmed = true;
        else if (args[index] === "--attachment-id" && args[index + 1])
          rawAttachmentIds.push(args[++index]!);
        else if (args[index] === "--mention" && args[index + 1]) rawMentions.push(args[++index]!);
        else throw new Error("Usage:");
      }
      const outputMode = json ? "json" : "text";
      // Repeatable; duplicate values collapse to one occurrence. No client-side count cap
      // (Raft's send schema has none either); the server enforces the per-message limit.
      const attachmentIds = rawAttachmentIds.length ? [...new Set(rawAttachmentIds)] : undefined;
      if (attachmentIds?.some((id) => !UUID_PATTERN.test(id)))
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
      if (attachmentIds && sendDraft)
        throw withOutputMode(
          new CliError({
            code: "SEND_DRAFT_ATTACHMENTS_UNSUPPORTED",
            message:
              "--attachment-id cannot be used with --send-draft. Use a normal send to replace the draft.",
            retryable: false,
            draftSaved: false,
            suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
          }),
          outputMode,
        );
      if (continueAnyway && !sendDraft)
        throw withOutputMode(
          new CliError({
            code: "SEND_DRAFT_ANYWAY_REQUIRES_SEND_DRAFT",
            message: "--anyway can only be used together with --send-draft.",
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
          ...(attachmentIds ? { attachmentIds } : {}),
          ...(mentions ? { mentions } : {}),
          ...(targetConfirmed ? { targetConfirmed: true } : {}),
        };
    }
  }
  throw new Error(
    "Usage: coforge channel mute|unmute --target '#channel' | coforge channel info <target> | coforge channel members <target> | coforge channel join --target '#channel' | coforge channel leave --target '#channel' | coforge channel create --name <name> [--description <text>] [--json] | coforge channel update --target '#channel' [--name <name>] [--description <text>] [--json] | coforge channel lifecycle archive|unarchive --target '#channel' [--json] | coforge channel add-member --target '#channel' (--user @handle | --agent @handle) [--json] | coforge channel remove-member --target '#channel' (--user @handle | --agent @handle) [--json] | coforge thread unfollow --target '#channel:message-id' | coforge inbox check | coforge message check [--target @user|#channel] | coforge message search --query <text> [--target <target>] [--sender <handle>] [--sort relevance|recent] [--before <iso>] [--after <iso>] [--limit <n>] [--offset <n>] | coforge message read --target @user | coforge message send --target @user [--send-draft] [--anyway] [--reviewer-isolation] [--json] [--attachment-id <uuid>]... [--mention human:<uuid>:<handle>|agent:<uuid>:<handle>]... [--target-confirmed] | coforge message resolve <message-id> | coforge message react --message-id <id> --emoji <emoji> [--remove] | coforge task list (--target <target> | --mine) [--status all|todo|in_progress|in_review|done|closed] | coforge task create --target <target> --title <title>... [--assignee @handle] [--creates-resource] | coforge task claim --target <target> (--number <n> | --message-id <id>)... [--reviewer-isolation] | coforge task convert|unclaim|assign|unassign|update|amend|history|delete|receipt ... | coforge attachment view [--id] <id> --output <path> [--json] | coforge attachment upload --path <file> (--target <target>|--channel <target>) [--mime-type <type>] [--json] | coforge weekly-report context --subject-type report|cycle --subject-id <uuid> | coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>] | coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>] | coforge weekly-report-collect submit-pack|submit-empty|submit-failure --run-id <uuid> --request-id <uuid> [--markdown <path>] [--reason <text>] | coforge action prepare --target <target> | coforge manual get <topic> [--intent <text>] [--reason <text>] | coforge manual search \"<keywords>\" [--intent <text>] [--reason <text>] | coforge whoami [--json] | coforge version [--json] | coforge user info <name> [--json] | coforge profile show [<target>] [--json] | coforge profile update [--display-name <text>] [--description <text>] [--json] | coforge mention pending [--json] | coforge mention notify <resolution-id>... [--json] | coforge mention add <resolution-id>... [--json]",
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
 * public and there is no private/visibility column. */
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

const MANUAL_INTENT_REASON_MIN_LENGTH = 12;
const MANUAL_INTENT_REASON_MAX_LENGTH = 500;
const MANUAL_USAGE =
  'Usage: coforge manual get <topic> [--intent "<text>"] [--reason "<text>"] | coforge manual ' +
  'search "<keywords>" [--intent "<text>"] [--reason "<text>"]';

function isValidManualField(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  const trimmed = value.trim();
  return (
    trimmed.length >= MANUAL_INTENT_REASON_MIN_LENGTH &&
    trimmed.length <= MANUAL_INTENT_REASON_MAX_LENGTH
  );
}

/** Client-side mirror of the server's `--intent`/`--reason` validation (see
 * `apps/web/src/server/agents/manual/manual-validation.server.ts`): optional; non-empty values are trimmed, 12-500
 * characters. When both are invalid, one error names both rather than only the first checked. */
function validateManualIntentReasonArgs(intent: string | undefined, reason: string | undefined) {
  const intentValid = isValidManualField(intent);
  const reasonValid = isValidManualField(reason);
  if (intentValid && reasonValid) return;
  const range = `${MANUAL_INTENT_REASON_MIN_LENGTH}-${MANUAL_INTENT_REASON_MAX_LENGTH}`;
  const safetyNote =
    "Never put a raw prompt, a credential, a private URL, or a message payload in either field.";
  if (!intentValid && !reasonValid)
    throw new CliError({
      code: "KNOWLEDGE_INTENT_INVALID",
      message:
        `--intent and --reason, when provided, must be ${range} characters after ` +
        `trimming. ${safetyNote}`,
      retryable: false,
    });
  if (!intentValid)
    throw new CliError({
      code: "KNOWLEDGE_INTENT_INVALID",
      message:
        `--intent, when provided, must be ${range} characters after trimming: state what you ` +
        `ultimately want to accomplish. ${safetyNote}`,
      retryable: false,
    });
  throw new CliError({
    code: "KNOWLEDGE_REASON_INVALID",
    message:
      `--reason, when provided, must be ${range} characters after trimming: state why the ` +
      `Manual is needed at this point. ${safetyNote}`,
    retryable: false,
  });
}

const WHOAMI_USAGE = "Usage: coforge whoami [--json]";
const VERSION_USAGE = "Usage: coforge version [--json]";

function parseWhoamiArgs(args: readonly string[]): WhoamiInvocation {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new Error(WHOAMI_USAGE);
  }
  return { command: "whoami", ...(json ? { json: true } : {}) };
}

function parseVersionArgs(args: readonly string[]): VersionInvocation {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new Error(VERSION_USAGE);
  }
  return { command: "version", ...(json ? { json: true } : {}) };
}

function parseManualArgs(args: readonly string[]): ManualInvocation {
  const sub = args[0];
  let value: string | undefined;
  let intent: string | undefined;
  let reason: string | undefined;
  // The positional may come before or after the flags; Agents write both orders.
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === "--intent" || name === "--reason") {
      const flagValue = args[index + 1];
      if (flagValue === undefined) throw new Error(MANUAL_USAGE);
      if (name === "--intent") intent = flagValue;
      else reason = flagValue;
      index += 1;
    } else if (name.startsWith("--") || value !== undefined) throw new Error(MANUAL_USAGE);
    else value = name;
  }
  if (!value?.trim()) throw new Error(MANUAL_USAGE);
  validateManualIntentReasonArgs(intent, reason);
  const context = { intent: intent?.trim() ?? "", reason: reason?.trim() ?? "" };
  return sub === "get"
    ? { command: "manual-get", topic: value.trim(), ...context }
    : { command: "manual-search", query: value.trim(), ...context };
}

/** `@handle` and `handle` are both accepted; the leading `@` is stripped before the CLI sends
 * the name to the server (Usernames themselves never carry one). */
function stripHandlePrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

const USER_INFO_USAGE = "Usage: coforge user info <name> [--json]";

function parseUserInfoArgs(args: readonly string[]): UserInfoInvocation {
  let name: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg !== undefined && !arg.startsWith("--") && name === undefined) name = arg;
    else throw new Error(USER_INFO_USAGE);
  }
  const trimmed = name?.trim();
  if (!trimmed) throw new Error(USER_INFO_USAGE);
  return {
    command: "user-info",
    name: stripHandlePrefix(trimmed),
    ...(json ? { json: true } : {}),
  };
}

const PROFILE_SHOW_USAGE = "Usage: coforge profile show [<target>] [--json]";

function parseProfileShowArgs(args: readonly string[]): ProfileShowInvocation {
  let target: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg !== undefined && !arg.startsWith("--") && target === undefined) target = arg;
    else throw new Error(PROFILE_SHOW_USAGE);
  }
  const trimmed = target?.trim();
  return {
    command: "profile-show",
    ...(trimmed ? { target: stripHandlePrefix(trimmed) } : {}),
    ...(json ? { json: true } : {}),
  };
}

const PROFILE_UPDATE_USAGE =
  'Usage: coforge profile update [--display-name "<text>"] [--description "<text>"] [--json]';

function parseProfileUpdateArgs(args: readonly string[]): ProfileUpdateInvocation {
  let displayName: string | undefined;
  let description: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--display-name" || arg === "--description") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(PROFILE_UPDATE_USAGE);
      if (arg === "--display-name") displayName = value;
      else description = value;
      index += 1;
      continue;
    }
    throw new Error(PROFILE_UPDATE_USAGE);
  }
  if (displayName === undefined && description === undefined) throw new Error(PROFILE_UPDATE_USAGE);
  return {
    command: "profile-update",
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(json ? { json: true } : {}),
  };
}

const MENTION_USAGE =
  "Usage: coforge mention pending [--json] | coforge mention notify <resolution-id>... [--json] | coforge mention add <resolution-id>... [--json]";

function parseMentionArgs(args: readonly string[]): MentionInvocation {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  const positionals = rest.filter((arg) => arg !== "--json");
  if (positionals.some((arg) => arg.startsWith("--"))) throw new Error(MENTION_USAGE);
  if (sub === "pending") {
    if (positionals.length) throw new Error(MENTION_USAGE);
    return { command: "mention-pending", ...(json ? { json: true } : {}) };
  }
  if (sub === "notify" || sub === "add") {
    const resolutionIds = [...new Set(positionals.map((id) => id.trim()).filter(Boolean))];
    if (!resolutionIds.length)
      throw new CliError({
        code: "INVALID_ARG",
        message: "At least one resolution id is required.",
        retryable: false,
        outputMode: json ? "json" : "text",
      });
    return {
      command: "mention-action",
      action: sub,
      resolutionIds,
      ...(json ? { json: true } : {}),
    };
  }
  throw new Error(MENTION_USAGE);
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
  if (invocation.command === "whoami") {
    const result = buildWhoamiResult();
    if (invocation.json) return JSON.stringify({ ok: true, data: result });
    return formatWhoami(result);
  }
  if (invocation.command === "version") {
    if (!transport.version) throw new Error("Version transport is unavailable");
    const response = await transport.version();
    const info = {
      cli: COFORGE_CLI_VERSION,
      daemon: response.daemonVersion,
      ...(response.computerVersion ? { computer: response.computerVersion } : {}),
    };
    if (invocation.json) return JSON.stringify({ ok: true, data: info });
    return formatVersionInfo(info);
  }
  if (invocation.command === "manual-get") {
    if (!transport.manualGet) throw new Error("Manual transport is unavailable");
    const result = await transport.manualGet(
      invocation.topic,
      invocation.intent,
      invocation.reason,
    );
    return formatManualGet(result.content);
  }
  if (invocation.command === "manual-search") {
    if (!transport.manualSearch) throw new Error("Manual transport is unavailable");
    const result = await transport.manualSearch(
      invocation.query,
      invocation.intent,
      invocation.reason,
    );
    return formatManualSearchResults(result.results);
  }
  if (invocation.command === "user-info") {
    if (!transport.userInfo) throw new Error("User info transport is unavailable");
    const result = await transport.userInfo(invocation.name);
    return invocation.json ? result : formatUserInfo(result);
  }
  if (invocation.command === "profile-show") {
    if (!transport.profileShow) throw new Error("Profile transport is unavailable");
    const result = await transport.profileShow(invocation.target);
    return invocation.json ? result : formatProfile(result);
  }
  if (invocation.command === "profile-update") {
    if (!transport.profileUpdate) throw new Error("Profile transport is unavailable");
    const result = await transport.profileUpdate({
      displayName: invocation.displayName,
      description: invocation.description,
    });
    return invocation.json ? result : formatProfile(result);
  }
  if (invocation.command === "mention-pending") {
    if (!transport.mentionPending) throw new Error("Mention transport is unavailable");
    const outputMode = invocation.json ? "json" : "text";
    const result = await transport.mentionPending().catch((error: unknown) => {
      throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
    });
    return invocation.json
      ? { ok: true, pendingMentionActions: result.pendingMentionActions }
      : formatPendingMentionActions(result.pendingMentionActions);
  }
  if (invocation.command === "mention-action") {
    if (!transport.mentionExecute) throw new Error("Mention transport is unavailable");
    const outputMode = invocation.json ? "json" : "text";
    const { action, resolutionIds } = invocation;
    const result = await transport
      .mentionExecute({ action, resolutionIds })
      .catch((error: unknown) => {
        throw error instanceof CliError ? withOutputMode(error, outputMode) : error;
      });
    const incomplete = incompleteMentionActions(action, resolutionIds, result.results);
    if (incomplete.length)
      throw new CliError({
        code: "MENTION_ACTION_FAILED",
        message: `Mention ${action} did not complete for every requested target: ${incomplete.join(", ")}`,
        retryable: false,
        details: { action: result.action, results: result.results },
        outputMode,
      });
    return invocation.json
      ? { ok: true, action: result.action, results: result.results }
      : formatMentionActionResults(result.action, result.results);
  }
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
    let command = { ...invocation.task, idempotencyKey: crypto.randomUUID() } as TaskCommand;
    if (
      (command.operation === "update" || command.operation === "unclaim") &&
      command.expectedRevision === undefined
    ) {
      const listed = await transport.task({
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        target: command.target,
      });
      const current = listed.tasks.find((task) => task.number === command.number);
      if (!current)
        throw new Error(`Task #${command.number} was not found; read the Task list again`);
      command = { ...command, expectedRevision: current.revision };
    }
    try {
      const result = await transport.task(command);
      if (result.state === "held")
        return formatHeldTaskRequest(result, command.freshnessContextMode === "withheld");
      return formatTaskResult(command, result);
    } catch (error) {
      // Deleting is irreversible and a refusal is an authority fact, not a race: name who may.
      if (
        error instanceof CliError &&
        command.operation === "delete" &&
        error.proxy?.upstreamStatus === 403
      )
        throw new CliError({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          correlationId: error.correlationId,
          proxy: error.proxy,
          suggestedNextAction:
            "Only the task's creator or a Workspace owner or admin can delete a task; ask one of them, or close it instead.",
        });
      // A typed failure is already redacted where it was raised; anything else may carry detail.
      if (command.freshnessContextMode === "withheld" && !(error instanceof CliError))
        throw new Error("Reviewer-isolation Task request failed; upstream detail was withheld");
      throw error;
    }
  }
  if (invocation.command === "weekly-report") {
    if (!transport.weeklyReport) throw new Error("Weekly report transport is unavailable");
    return transport.weeklyReport(invocation.weeklyReport);
  }
  if (invocation.command === "weekly-report-collect") {
    if (!transport.weeklyReportCollect)
      throw new Error("Weekly report collect transport is unavailable");
    let collect = invocation.collect;
    if (invocation.markdownPath) {
      const packMarkdown = await Bun.file(invocation.markdownPath).text();
      collect = { ...collect, packMarkdown };
    }
    const result = await transport.weeklyReportCollect(collect);
    return `Collect slot ${result.status} (run ${result.runId}; allTerminal=${result.allTerminal}; canSynthesize=${result.canSynthesize}).`;
  }
  if (invocation.command === "weekly-report-key-points") {
    if (!transport.weeklyReportKeyPoints)
      throw new Error("Weekly report key-points transport is unavailable");
    let keyPoints = invocation.keyPoints;
    if (invocation.markdownPath) {
      const markdown = await Bun.file(invocation.markdownPath).text();
      keyPoints = { ...keyPoints, markdown };
    }
    const result = await transport.weeklyReportKeyPoints(keyPoints);
    return `Key points ${result.status} (report ${result.reportId}).`;
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
    if (invocation.sendDraft && (await sendDraftStdinHasContent())) {
      throw withOutputMode(
        new CliError({
          code: "SEND_DRAFT_STDIN_UNSUPPORTED",
          message: [
            "--send-draft sends the current saved draft and does not accept stdin.",
            "To update the draft, send the revised content normally without --send-draft:",
            `  coforge message send --target "${invocation.target}" <<'COFORGE_MESSAGE'`,
            "  revised message",
            "  COFORGE_MESSAGE",
          ].join("\n"),
          retryable: false,
          draftSaved: false,
          suggestedNextAction: NO_MESSAGE_SENT_NEXT_ACTION,
        }),
        outputMode,
      );
    }
    const body = invocation.sendDraft ? undefined : await readPipedSendContent();
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
        attachmentIds: invocation.attachmentIds,
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
          result as HeldSendResult,
          invocation.freshnessContextMode === "withheld",
        ),
        outputMode,
      );
    const sent = result as {
      messageId?: string;
      recentUnread?: AgentMessageRecord[];
      pendingMentionActions?: PendingMentionAction[];
      unresolvedMentionHandles?: string[];
    };
    const undelivered = undeliveredMentionError(invocation.target, sent, outputMode);
    if (invocation.json) {
      if (undelivered) throw undelivered;
      return JSON.stringify({
        state: "sent",
        target: invocation.target,
        messageId: sent.messageId,
        recentUnread: sent.recentUnread ?? [],
      });
    }
    if (undelivered) throw undelivered;
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
  if (command === "check") return formatMessageCheck(await transport.check(invocation.target));
  const readOptions = invocation.command === "read" ? invocation : undefined;
  const readResponse = (await transport.read(invocation.target, readOptions)) as {
    messages: AgentMessageRecord[];
    hasOlder?: boolean;
    hasNewer?: boolean;
  };
  return formatReadWindow(invocation.target, readResponse, { around: readOptions?.around });
}

export type WhoamiResult = {
  agentId?: string;
  agentName?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  computerId?: string;
  computerName?: string;
  computerHostname?: string;
  agentWorkspacePath?: string;
  proxyUrl?: string;
  /** CoForge has only daemon-spawned Agents today (no self-hosted Agent client), so this is
   * always `"daemon-managed"`; the field exists so a future client kind has somewhere to report. */
  clientMode: "daemon-managed";
  credential: {
    source: "agent-context-env" | "none";
    present: boolean;
    /** First 4 characters (the fixed `sfp_` prefix) plus an ellipsis; never the token value. */
    redacted?: string;
  };
};

function trimmedEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * `coforge whoami`: deliberately local — it answers "what
 * identity and endpoint would my next command use", read only from the process environment the
 * Daemon already set for this Agent process (`code-agent/environment.ts`). It never makes a
 * request. `COFORGE_DAEMON_SOCKET` is always set to `""` for an Agent launch (`daemon-runtime/
 * runtime.ts`), so it carries no information and is not reported here.
 */
function buildWhoamiResult(): WhoamiResult {
  const context = trimmedEnv(Bun.env.COFORGE_AGENT_CONTEXT);
  return {
    agentId: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_ID),
    agentName: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_NAME),
    workspaceId: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_ID),
    workspaceSlug: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_SLUG),
    workspaceName: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_NAME),
    computerId: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_ID),
    computerName: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_NAME),
    computerHostname: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_HOSTNAME),
    agentWorkspacePath: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH),
    proxyUrl: trimmedEnv(Bun.env.COFORGE_AGENT_PROXY_URL),
    clientMode: "daemon-managed",
    credential: {
      source: context ? "agent-context-env" : "none",
      present: Boolean(context),
      ...(context ? { redacted: `${context.slice(0, 4)}…` } : {}),
    },
  };
}

function formatWhoami(result: WhoamiResult): string {
  const lines = ["## Who am I", ""];
  if (result.agentId) lines.push(`Agent ID: ${result.agentId}`);
  if (result.agentName) lines.push(`Agent name: @${result.agentName}`);
  if (result.workspaceId) lines.push(`Workspace ID: ${result.workspaceId}`);
  if (result.workspaceSlug) lines.push(`Workspace slug: ${result.workspaceSlug}`);
  if (result.workspaceName) lines.push(`Workspace name: ${result.workspaceName}`);
  if (result.computerId) lines.push(`Computer ID: ${result.computerId}`);
  if (result.computerName) lines.push(`Computer name: ${result.computerName}`);
  if (result.computerHostname) lines.push(`Computer hostname: ${result.computerHostname}`);
  if (result.agentWorkspacePath) lines.push(`Agent workspace: ${result.agentWorkspacePath}`);
  if (result.proxyUrl) lines.push(`Agent proxy: ${result.proxyUrl}`);
  lines.push(`Client mode: ${result.clientMode}`);
  lines.push(
    `Credential: source=${result.credential.source} present=${result.credential.present ? "yes" : "no"}` +
      (result.credential.redacted ? ` redacted=${result.credential.redacted}` : ""),
  );
  return lines.join("\n");
}

type VersionInfo = { cli: string; daemon?: string; computer?: string };

/** `coforge version`'s text output: `CLI:`/`Daemon:`/`Computer:` lines, in that order, each
 * omitted only when unknown. `CLI` is always known; `Daemon`/`Computer` come from the live query. */
function formatVersionInfo(info: VersionInfo): string {
  const lines = [`CLI: ${info.cli}`];
  if (info.daemon) lines.push(`Daemon: ${info.daemon}`);
  if (info.computer) lines.push(`Computer: ${info.computer}`);
  return lines.join("\n");
}

/**
 * The `runtimeContext` the CLI renders and serializes: the server's fields plus `agentWorkspacePath`,
 * which only the local Computer knows and which the CLI fills from
 * `COFORGE_CURRENT_AGENT_WORKSPACE_PATH` (mirroring `agentRuntimeContextEnvironment` in
 * `packages/daemon/src/code-agent/environment.ts`). Undefined when nothing is known at all.
 */
function cliRuntimeContext(
  runtimeContext: WorkspaceInfoRuntimeContext | undefined,
): WorkspaceInfoRuntimeContext | undefined {
  const agentWorkspacePath = Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH?.trim() || undefined;
  if (!runtimeContext && !agentWorkspacePath) return undefined;
  return {
    ...runtimeContext,
    ...(agentWorkspacePath ? { agentWorkspacePath } : {}),
  };
}

/**
 * The "Current Runtime" block: authoritative, server-authored identity for this Agent process,
 * printed above the default summary and included in `--full`. Each bullet appears only when its
 * value is known; the whole block is "" when nothing is known at all.
 */
function formatCurrentRuntimeBlock(
  runtimeContext: WorkspaceInfoRuntimeContext | undefined,
): string {
  if (!runtimeContext) return "";
  const bullets: string[] = [];
  const agent = runtimeContext.agentName
    ? `@${runtimeContext.agentName}${runtimeContext.agentId ? ` (${runtimeContext.agentId})` : ""}`
    : runtimeContext.agentId;
  if (agent) bullets.push(`- Agent: ${agent}`);
  if (runtimeContext.runtime) bullets.push(`- Provider: ${runtimeContext.runtime}`);
  if (runtimeContext.model) bullets.push(`- Model: ${runtimeContext.model}`);
  if (runtimeContext.reasoning) bullets.push(`- Reasoning: ${runtimeContext.reasoning}`);
  const workspace = runtimeContext.workspaceName
    ? `${runtimeContext.workspaceName}${runtimeContext.workspaceSlug ? ` (${runtimeContext.workspaceSlug})` : ""}`
    : runtimeContext.workspaceSlug;
  if (workspace) bullets.push(`- Workspace: ${workspace}`);
  const computer = runtimeContext.computerName
    ? `${runtimeContext.computerName}${runtimeContext.computerId ? ` (${runtimeContext.computerId})` : ""}`
    : runtimeContext.computerId;
  if (computer) bullets.push(`- Computer: ${computer}`);
  if (runtimeContext.computerHostname)
    bullets.push(`- Hostname: ${runtimeContext.computerHostname}`);
  if (runtimeContext.computerOs) bullets.push(`- OS: ${runtimeContext.computerOs}`);
  if (runtimeContext.computerVersion)
    bullets.push(`- Computer version: v${runtimeContext.computerVersion}`);
  if (runtimeContext.agentWorkspacePath)
    bullets.push(`- Agent workspace: ${runtimeContext.agentWorkspacePath}`);
  if (bullets.length === 0) return "";
  return [
    "### Current Runtime",
    "Authoritative context for this Agent process. Do not infer Computer identity from hostname or cwd when this section is present.",
    ...bullets,
  ].join("\n");
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
  const runtimeContext = cliRuntimeContext(result.runtimeContext);
  if (section === "summary") {
    const counts = `${result.workspace.name} (${result.workspace.slug})\nagents=${result.agents.length} humans=${result.humans.length} projects=${result.projects.length}`;
    const block = formatCurrentRuntimeBlock(runtimeContext);
    return block ? `${block}\n\n${counts}` : counts;
  }
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
  return JSON.stringify(runtimeContext ? { ...result, runtimeContext } : result);
}

function formatMessageCheck(result: { messages: AgentMessageRecord[]; hasMore?: boolean }): string {
  if (result.messages.length === 0) return "No new messages.";
  const footer = result.hasMore
    ? "More messages are pending. Run `coforge message check` again."
    : "No more new messages.";
  const body = result.messages.map(formatMessage).join("\n");
  const hint = formatTaskWorkflowHint(result.messages);
  return hint ? `${body}\n\n${hint}\n${footer}` : `${body}\n\n${footer}`;
}

function formatMessage(message: AgentMessageRecord): string {
  return formatMessageLine(message);
}

function formatMessageResolve(result: unknown): string {
  const response = result as { messages?: AgentMessageRecord[] };
  const message = response.messages?.[0];
  if (!message) throw new Error("message not found or not visible to this Agent");
  const line = formatMessage(message);
  const hint = formatTaskWorkflowHint([message]);
  return hint ? `${line}\n${hint}` : line;
}

function formatReaction(messageId: string, emoji: string, remove: boolean): string {
  const shortId = messageId.slice(0, 8);
  return `Reaction ${emoji} ${remove ? "removed from" : "added to"} message ${shortId}.`;
}

function isHeldSend(result: unknown): result is HeldSendResult {
  if (!result || typeof result !== "object") return false;
  return (result as { state?: unknown }).state === "held";
}

/** Raft's held-send envelope, as the daemon hands it to the CLI. */
type HeldSendResult = {
  state: "held";
  decision?: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  continueAnywaySuggested?: boolean;
  withheldMessageCount?: number;
};

const HELD_SEND_NEXT_ACTION =
  "Review the held context, then update the draft or send the current draft unchanged.";

/**
 * A send whose message was queued but some of whose @mentions reached no one is a partial result:
 * the message must not be sent again, and each mention has its own recovery. In text mode what was
 * achieved goes to stdout (the undelivered mentions, then the queued line) before the error; with
 * `--json` the whole partial result is the error's details.
 */
function undeliveredMentionError(
  target: string,
  sent: {
    messageId?: string;
    recentUnread?: AgentMessageRecord[];
    pendingMentionActions?: PendingMentionAction[];
    unresolvedMentionHandles?: string[];
  },
  outputMode: "text" | "json",
): CliError | undefined {
  const actions = sent.pendingMentionActions ?? [];
  const unresolved = [...new Set(sent.unresolvedMentionHandles ?? [])];
  const count = actions.length + unresolved.length;
  if (count === 0) return undefined;
  const recoveries = actions.flatMap(
    (action) => senderPendingMention(action).recoveryCommand ?? [],
  );
  return new CliError({
    code: "MENTION_DELIVERY_FAILED",
    message: `Partial result for message ${sent.messageId}: message status=queued; ${count} @mention${count === 1 ? "" : "s"} status=not_queued.`,
    retryable: false,
    effect: "message_queued",
    draftSaved: false,
    outputMode,
    stdoutText:
      outputMode === "text"
        ? `${formatUndeliveredMentions(actions, unresolved)}\n\n${formatSendSuccess(target, sent as { messageId: string }, sent.recentUnread, true)}`
        : undefined,
    details: {
      result: {
        ...sent,
        state: "partial",
        message: { status: "queued", id: sent.messageId },
        pendingMentionActions: actions.map(senderPendingMention),
        ...(unresolved.length
          ? { unresolvedMentionWarnings: unresolved.map(senderUnresolvedMention) }
          : {}),
      },
    },
    suggestedNextAction: [
      "The message is already queued.",
      ...(recoveries.length
        ? [
            `Run only the per-token mention ${recoveries.length === 1 ? "recovery" : "recoveries"}: ${recoveries.map((command) => `\`${command}\``).join("; ")}.`,
          ]
        : []),
      ...(unresolved.length
        ? [
            "If an unresolved token was literal prose, wrap it in code; otherwise verify the exact handle and send only a corrected follow-up mention.",
          ]
        : []),
      "Do not resend the queued message.",
    ].join(" "),
  });
}

/**
 * A hold is not a transport failure — the server made a definite decision and the daemon already
 * saved the reply as a local draft — but it is still not delivery, so `message send` reports it as
 * a typed error rather than a quiet success. Reviewer isolation keeps withholding message content;
 * the ordinary case keeps printing the existing rich held-context report (`formatHeldSend`).
 */
function heldSendCliError(
  target: string,
  result: HeldSendResult,
  reviewerIsolation: boolean,
): CliError {
  if (reviewerIsolation) {
    const count =
      typeof result.newMessageCount === "number"
        ? result.newMessageCount
        : typeof result.withheldMessageCount === "number"
          ? result.withheldMessageCount
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
  // One JSON document, as before. The held message targets are already in `entries` (the daemon
  // returns them next to the App Inbox items), so an Agent can read the local view from this
  // output; a human-readable rendering would change machine output that callers parse today, and
  // this command has no `--json` escape hatch to change it behind.
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

/** How long `--send-draft` watches stdin before deciding nothing was piped in (Raft's own bounded
 * observation window: the flag replays the daemon-held copy, so piped content is a mistake to
 * report, not a body to silently discard). */
const SEND_DRAFT_STDIN_OBSERVATION_MS = 150;

/** Reads the bytes a caller piped in. The stream is single-use, so an invocation that already
 * observed it (only possible when one process runs several sends, as the test harness does) has
 * nothing left to read rather than an error to report. */
async function readPipedSendContent(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

async function sendDraftStdinHasContent(): Promise<boolean> {
  const reader = Bun.stdin.stream().getReader();
  const deadline = new Promise<{ done: true; value: undefined }>((resolve) =>
    setTimeout(
      () => resolve({ done: true as const, value: undefined }),
      SEND_DRAFT_STDIN_OBSERVATION_MS,
    ),
  );
  try {
    const first = await Promise.race([reader.read(), deadline]);
    return !first.done && (first.value?.length ?? 0) > 0;
  } finally {
    reader.releaseLock();
  }
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
    request.timezone = DEFAULT_REMINDER_TIMEZONE;
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

function parseWeeklyReportCollectArgs(args: readonly string[]): WeeklyReportCollectInvocation {
  const operation = args[0];
  if (operation !== "submit-pack" && operation !== "submit-empty" && operation !== "submit-failure")
    throw new Error("Usage:");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  const runId = values.get("--run-id");
  const requestId = values.get("--request-id");
  if (!runId || !RFC_UUID_PATTERN.test(runId) || !requestId || !RFC_UUID_PATTERN.test(requestId))
    throw new Error("Usage:");
  if (operation === "submit-pack") {
    const markdownPath = values.get("--markdown");
    if (!markdownPath || values.size !== 3) throw new Error("Usage:");
    return {
      command: "weekly-report-collect",
      markdownPath,
      collect: {
        requestId,
        runId,
        outcome: "ready",
      },
    };
  }
  if (operation === "submit-empty") {
    if (values.size !== 2) throw new Error("Usage:");
    return {
      command: "weekly-report-collect",
      collect: { requestId, runId, outcome: "empty" },
    };
  }
  const reason = values.get("--reason");
  if (!reason || values.size !== 3) throw new Error("Usage:");
  return {
    command: "weekly-report-collect",
    collect: { requestId, runId, outcome: "failed", failureReason: reason },
  };
}

function parseWeeklyReportKeyPointsArgs(args: readonly string[]): WeeklyReportKeyPointsInvocation {
  if (args[0] !== "submit") throw new Error("Usage:");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  const reportId = values.get("--report-id");
  const requestId = values.get("--request-id");
  const markdownPath = values.get("--markdown");
  if (
    !reportId ||
    !RFC_UUID_PATTERN.test(reportId) ||
    !requestId ||
    !RFC_UUID_PATTERN.test(requestId) ||
    !markdownPath ||
    values.size !== 3
  )
    throw new Error("Usage:");
  return {
    command: "weekly-report-key-points",
    markdownPath,
    keyPoints: { requestId, reportId, markdown: "" },
  };
}

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
      !RFC_UUID_PATTERN.test(subjectId)
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
    if (cycleId && !RFC_UUID_PATTERN.test(cycleId)) throw new Error("Usage:");
    if (cursor && !RFC_UUID_PATTERN.test(cursor)) throw new Error("Usage:");
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
  if (!reportId || !RFC_UUID_PATTERN.test(reportId) || !section) throw new Error("Usage:");
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

const TASK_OPERATIONS = [
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
] as const;
type TaskOperation = (typeof TASK_OPERATIONS)[number];

/** The flags each `task` subcommand takes. */
const TASK_FLAGS: Record<TaskOperation, readonly string[]> = {
  list: ["--target", "--mine", "--status"],
  create: ["--target", "--title", "--assignee", "--creates-resource"],
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
  delete: ["--target", "--number"],
  receipt: [
    "--target",
    "--number",
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
  ],
};

/** Flags a subcommand accepts more than once. `update` counts its `--number`s only to refuse
 * more than one by name. */
const TASK_REPEATABLE_FLAGS: Partial<Record<TaskOperation, readonly string[]>> = {
  create: ["--title"],
  claim: ["--number", "--message-id"],
  update: ["--number"],
};

const TASK_SWITCHES = new Set([
  "--clear-description",
  "--reviewer-isolation",
  "--mine",
  "--creates-resource",
]);

const TASK_TARGET = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,31})$/;

function invalidTaskArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

function taskNumber(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined) throw invalidTaskArg("--number is required");
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value <= 0)
    throw invalidTaskArg(`--number must be a positive integer; got ${raw}`);
  return value;
}

function expectedRevisionOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value < 0)
    throw invalidTaskArg(`--expected-revision must be a non-negative integer; got ${raw}`);
  return value;
}

/** A handle the server can resolve: `@`, then a lowercase username or Agent name. */
const TASK_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,63}$/;

/** A `@handle` option: trimmed, with the handle after `@` trimmed too. */
function handleOption(raw: string, message: string): string {
  const value = raw.trim();
  const handle = `@${value.slice(1).trim()}`;
  if (!value.startsWith("@") || !TASK_HANDLE.test(handle)) throw invalidTaskArg(message);
  return handle;
}

function parseTaskArgs(args: readonly string[]): TaskInvocation {
  const operation = args[0] as TaskOperation | undefined;
  if (!operation || !(TASK_OPERATIONS as readonly string[]).includes(operation))
    throw new Error("Usage:");
  const allowed = TASK_FLAGS[operation];
  const repeatable = TASK_REPEATABLE_FLAGS[operation] ?? [];
  const values = new Map<string, string[]>();
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]!;
    if (!allowed.includes(name)) throw new Error("Usage:");
    if (values.has(name) && !repeatable.includes(name)) throw new Error("Usage:");
    if (TASK_SWITCHES.has(name)) {
      values.set(name, ["true"]);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error("Usage:");
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  const one = (flag: string) => values.get(flag)?.[0];

  const mine = values.has("--mine");
  const target = one("--target");
  if (operation === "list") validateTaskListScope(target, mine, one("--status"));
  if (!mine) {
    if (!target?.trim()) throw invalidTaskArg("--target is required");
    if (!TASK_TARGET.test(target))
      throw invalidTaskArg(
        `--target must be a conversation ('#channel' or '@user'); got ${target}`,
      );
  }

  const task: Omit<TaskCommand, "idempotencyKey"> = {
    operation,
    target,
    ...(mine ? { mine: true } : {}),
  };
  if (operation === "list") {
    task.status = one("--status") as TaskStatus | "all" | undefined;
  } else if (operation === "create") {
    const titles = values.get("--title") ?? [];
    if (!titles.length) throw invalidTaskArg("--title is required (at least one)");
    if (titles.some((title) => !title.trim())) throw invalidTaskArg("--title must be nonblank");
    if (titles.length === 1) task.title = titles[0];
    else task.titles = titles;
    const assignee = one("--assignee");
    if (assignee !== undefined)
      task.assignee = handleOption(assignee, "--assignee must be an @handle");
    if (values.has("--creates-resource")) task.createsResource = true;
  } else if (operation === "convert") {
    const messageId = one("--message-id")?.trim();
    if (!messageId) throw invalidTaskArg("--message-id is required");
    task.messageId = messageId;
  } else if (operation === "claim") {
    const numbers = (values.get("--number") ?? []).map(taskNumber);
    const messageIds = (values.get("--message-id") ?? []).map((id) => id.trim());
    if (!numbers.length && !messageIds.length)
      throw invalidTaskArg("Provide at least one --number or --message-id");
    if (messageIds.some((id) => !id)) throw invalidTaskArg("--message-id must be nonblank");
    if (numbers.length === 1) task.number = numbers[0];
    else if (numbers.length) task.numbers = numbers;
    if (messageIds.length === 1) task.messageId = messageIds[0];
    else if (messageIds.length) task.messageIds = messageIds;
  } else if (operation === "update") {
    const numbers = values.get("--number") ?? [];
    if (numbers.length !== 1)
      throw invalidTaskArg(
        numbers.length === 0
          ? "Provide exactly one --number"
          : `task update accepts exactly one --number; received ${numbers.length}. Run task update once per task.`,
      );
    task.number = taskNumber(numbers[0]);
    const status = one("--status");
    if (!status || !(TASK_STATUSES as readonly string[]).includes(status))
      throw invalidTaskArg(`--status must be one of: ${TASK_STATUSES.join(", ")}; got ${status}`);
    task.status = status as TaskStatus;
  } else {
    task.number = taskNumber(one("--number"));
  }

  if (operation === "assign") {
    const assignee = one("--assignee")?.trim();
    if (!assignee)
      throw invalidTaskArg(
        "--assignee <@who> is required; to clear the assignee use `coforge task unassign`",
      );
    task.assignee = handleOption(
      assignee.startsWith("@") ? assignee : `@${assignee}`,
      "--assignee must be an @handle",
    );
  }
  if (operation === "amend") {
    const description = one("--description");
    const clear = values.has("--clear-description");
    if (description !== undefined && clear)
      throw invalidTaskArg("Use either --description or --clear-description, not both");
    const title = one("--title");
    if (title === undefined && description === undefined && !clear)
      throw invalidTaskArg(
        "At least one amendment is required: --title, --description, or --clear-description",
      );
    if (title !== undefined) task.title = title;
    if (clear) task.description = null;
    else if (description !== undefined) task.description = description;
  }
  if (operation === "receipt") task.receipt = taskReceiptArgs(one);
  const expectedRevision = expectedRevisionOption(one("--expected-revision"));
  if (expectedRevision !== undefined) task.expectedRevision = expectedRevision;
  if (
    ["claim", "update", "amend"].includes(operation) &&
    (values.has("--reviewer-isolation") || reviewerIsolationFromEnvironment())
  )
    task.freshnessContextMode = "withheld";
  return { command: "task", task };
}

/** The seven resource-receipt fields, each required and nonblank. */
function taskReceiptArgs(one: (flag: string) => string | undefined): TaskResourceReceipt {
  const required = (flag: string) => {
    const value = one(flag)?.trim();
    if (!value) throw invalidTaskArg(`${flag} is required and must be nonblank`);
    return value;
  };
  const teardownOwner = handleOption(
    required("--teardown-owner"),
    "--teardown-owner must be an @agent handle",
  );
  const expiry = new Date(required("--expiry"));
  if (!Number.isFinite(expiry.getTime()))
    throw invalidTaskArg("--expiry must be an ISO-8601 timestamp");
  return {
    object: required("--object"),
    purpose: required("--purpose"),
    teardownOwner,
    securityPrivacy: required("--security-privacy"),
    expiry: expiry.toISOString(),
    runbook: required("--runbook"),
    tracking: required("--tracking"),
  };
}

const TASK_LIST_STATUSES = ["all", ...TASK_STATUSES] as const;

/** `task list` reads one conversation (`--target`) or this Agent's own Tasks (`--mine`). */
function validateTaskListScope(target: string | undefined, mine: boolean, status?: string) {
  if (status !== undefined && !(TASK_LIST_STATUSES as readonly string[]).includes(status))
    throw invalidTaskArg(`--status must be one of ${TASK_LIST_STATUSES.join("|")}; got ${status}`);
  if (mine && target) throw invalidTaskArg("--mine cannot be combined with --target");
  if (!mine && !target) throw invalidTaskArg("--target is required (or pass --mine)");
}

/** A write the server held until the Agent has seen the conversation's newer messages. */
function formatHeldTaskRequest(result: TaskResult, reviewerIsolation: boolean): string {
  if (reviewerIsolation || result.freshnessContextMode === "withheld") {
    const count = result.newMessageCount ?? result.withheldMessageCount ?? 0;
    return `Reviewer-isolation freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} withheld.`;
  }
  const messages = result.heldMessages?.map(formatMessage).join("\n");
  return `Task request held.${messages ? ` Review newer messages:\n${messages}` : ""}`;
}

/** What a `task` subcommand prints for the server's answer. */
function formatTaskResult(command: TaskCommand, result: TaskResult): string {
  const target = command.target!;
  const task = result.tasks[0];
  switch (command.operation) {
    case "list":
      return command.mine
        ? formatMyTaskList(result, command.status)
        : formatTaskBoard(target, result, command.status);
    case "history":
      return formatTaskHistory(result);
    case "create":
      return formatTasksCreated(target, result);
    case "delete":
      return formatTaskDeleted(command.number!);
    case "receipt":
      return formatResourceReceiptRecorded(target, result);
    case "amend":
      return formatTaskAmended(result);
    case "claim": {
      const refusal = claimRefusal(target, result);
      if (refusal) throw refusal;
      return formatClaimResults(target, result);
    }
  }
  if (!task) throw new Error(`the server returned no task for task ${command.operation}`);
  switch (command.operation) {
    case "convert":
      return formatTaskConverted(target, task);
    case "unclaim":
      return formatTaskUnclaimed(task);
    case "assign":
    case "unassign":
      return formatTaskAssigned(task);
    case "update":
      return formatTaskStatusUpdated(task);
    default:
      throw new Error(`no output is defined for task ${command.operation}`);
  }
}

function historyActor(event: TaskHistoryEvent): string {
  if (event.actorType === "system") return "@system";
  return event.actorName ? `@${event.actorName}` : "<unresolved>";
}

function formatTaskHistory(result: TaskResult): string {
  const task = result.tasks[0]!;
  const events = result.history?.length
    ? result.history
        .map(
          (event) =>
            `seq=${event.seq} time=${event.createdAt} actor=${historyActor(event)} type=${event.eventType}\n  ${JSON.stringify(event.payload)}`,
        )
        .join("\n")
    : "No recorded events.";
  return `## Task #${task.number} history — revision ${task.revision}\n\n${task.title}\n\n${events}`;
}

function reviewerIsolationFromEnvironment(): boolean {
  const raw = Bun.env.COFORGE_REVIEWER_ISOLATION;
  const value = raw?.trim().toLowerCase();
  if (!value || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new CliError({
    code: "INVALID_ARG",
    message: `COFORGE_REVIEWER_ISOLATION must be one of: 1, true, 0, false; got ${raw}`,
    retryable: false,
  });
}
