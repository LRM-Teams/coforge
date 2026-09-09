import {
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  type AgentMessageRecord,
  type AgentReminderOperationResponse,
  type LocalReminderRequest,
} from "@coforge/protocol";

export type MessageCommand = "check" | "read" | "search" | "send";
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
  | { command: "send"; target: string; sendDraft?: boolean; continueAnyway?: boolean };
export type AttachmentInvocation = {
  command: "attachment-view";
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

export type MessageTransport = {
  check(): Promise<{ messages: AgentMessageRecord[] }>;
  read(
    target: string,
    options?: { before?: string; after?: string; around?: string; limit?: number },
  ): Promise<unknown>;
  search?(options: MessageSearchOptions): Promise<unknown>;
  send(
    target: string,
    body?: string,
    options?: { sendDraft?: boolean; continueAnyway?: boolean },
  ): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
  inboxCheck?(): Promise<unknown>;
  setChannelMuted?(target: string, muted: boolean): Promise<unknown>;
  reminder?(
    request: ReminderTransportRequest,
  ): Promise<AgentReminderOperationResponse | LocalReminderReceiptResponse>;
  setThreadFollowed?(target: string, followed: boolean): Promise<unknown>;
};

export function parseArgs(
  args: readonly string[],
):
  | MessageInvocation
  | AttachmentInvocation
  | InboxInvocation
  | ChannelInvocation
  | ReminderInvocation
  | ThreadInvocation {
  if (args[0] === "reminder") return parseReminderArgs(args.slice(1));
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
    const attachmentId = args[2];
    const output = args[3] === "--output" ? args[4] : undefined;
    if (attachmentId && output && args.length === 5)
      return { command: "attachment-view", attachmentId, output };
  }
  if (args[0] === "message" && isMessageCommand(args[1])) {
    if (args[1] === "check" && args.length === 2) return { command: "check" };
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
      for (let index = 2; index < args.length; index++) {
        if (args[index] === "--target" && args[index + 1]) target = args[++index];
        else if (args[index] === "--send-draft") sendDraft = true;
        else if (args[index] === "--anyway") continueAnyway = true;
        else throw new Error("Usage:");
      }
      if (target && (!continueAnyway || sendDraft))
        return {
          command: "send",
          target,
          ...(sendDraft ? { sendDraft: true } : {}),
          ...(continueAnyway ? { continueAnyway: true } : {}),
        };
    }
  }
  throw new Error(
    "Usage: coforge channel mute|unmute --target '#channel' | coforge thread unfollow --target '#channel:message-id' | coforge inbox check | coforge message check | coforge message search --query <text> [--target <target>] [--sender <handle>] [--sort relevance|recent] [--before <iso>] [--after <iso>] [--limit <n>] [--offset <n>] | coforge message read --target @user | coforge message send --target @user [--send-draft] [--anyway] | coforge attachment view <id> --output <path>",
  );
}

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  const invocation = parseArgs(args);
  if (invocation.command === "reminder") {
    if (!transport.reminder) throw new Error("Reminder transport is unavailable");
    const { command: _command, ...request } = invocation;
    return formatReminderResponse(request.operation, await transport.reminder(request));
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
  if (invocation.command === "attachment-view") {
    const result = await transport.view(invocation.attachmentId);
    await Bun.write(invocation.output, result.bytes);
    return { attachmentId: invocation.attachmentId, path: invocation.output };
  }
  const { command } = invocation;
  if (command === "send") {
    const result = await transport.send(
      invocation.target,
      invocation.sendDraft ? undefined : await new Response(Bun.stdin.stream()).text(),
      {
        sendDraft: invocation.sendDraft,
        continueAnyway: invocation.continueAnyway,
      },
    );
    if (isHeldSend(result)) throw heldSendError(invocation.target);
    return formatMessageRead(result);
  }
  if (command === "search") {
    if (!transport.search) throw new Error("Message search transport is unavailable");
    const { command: _command, ...options } = invocation;
    return formatMessageRead(await transport.search(options));
  }
  if (command === "check") return formatMessageCheck(await transport.check());
  return formatMessageRead(
    await transport.read(invocation.target, invocation.command === "read" ? invocation : undefined),
  );
}

function formatMessageCheck(result: { messages: AgentMessageRecord[] }): string {
  if (result.messages.length === 0) return "No new inbox messages.";
  return `${result.messages.map(formatMessage).join("\n")}\n\nNo more new inbox messages.`;
}

function formatMessage(message: AgentMessageRecord): string {
  return `[target=${message.target} msg=${message.id.slice(0, 8)} time=${message.createdAt}] ${message.sender}: ${message.body}`;
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
  return value === "check" || value === "read" || value === "search" || value === "send";
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
