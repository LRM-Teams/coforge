import type { AgentMessageRecord } from "@coforge/protocol";

export type MessageCommand = "check" | "read" | "send";
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
  | { command: "send"; target: string; sendDraft?: boolean; continueAnyway?: boolean };
export type AttachmentInvocation = {
  command: "attachment-view";
  attachmentId: string;
  output: string;
};
export type InboxInvocation = { command: "inbox-check" };

export type MessageTransport = {
  check(): Promise<{ messages: AgentMessageRecord[] }>;
  read(
    target: string,
    options?: { before?: string; after?: string; around?: string; limit?: number },
  ): Promise<unknown>;
  send(
    target: string,
    body?: string,
    options?: { sendDraft?: boolean; continueAnyway?: boolean },
  ): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
  inboxCheck?(): Promise<unknown>;
};

export function parseArgs(
  args: readonly string[],
): MessageInvocation | AttachmentInvocation | InboxInvocation {
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
    "Usage: coforge inbox check | coforge message check | coforge message read --target @user | coforge message send --target @user [--send-draft] [--anyway] | coforge attachment view <id> --output <path>",
  );
}

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  const invocation = parseArgs(args);
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
  if (command === "send")
    return formatMessageRead(
      await transport.send(
        invocation.target,
        invocation.sendDraft ? undefined : await new Response(Bun.stdin.stream()).text(),
        {
          sendDraft: invocation.sendDraft,
          continueAnyway: invocation.continueAnyway,
        },
      ),
    );
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
  return `[target=${message.target} time=${message.createdAt}] ${message.sender}: ${message.body}`;
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
  return value === "check" || value === "read" || value === "send";
}
