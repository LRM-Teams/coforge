export type MessageCommand = "check" | "read" | "send";
export type MessageInvocation = { command: MessageCommand; target?: string };
export type AttachmentInvocation = {
  command: "attachment-view";
  attachmentId: string;
  output: string;
};

export type MessageTransport = {
  check(target?: string): Promise<unknown>;
  read(target?: string): Promise<unknown>;
  send(target?: string, body?: string): Promise<unknown>;
  view(attachmentId: string): Promise<{ bytes: Uint8Array; fileName?: string }>;
};

export function parseArgs(args: readonly string[]): MessageInvocation | AttachmentInvocation {
  if (args[0] === "attachment" && args[1] === "view") {
    const attachmentId = args[2];
    const output = args[3] === "--output" ? args[4] : undefined;
    if (attachmentId && output && args.length === 5)
      return { command: "attachment-view", attachmentId, output };
  }
  if (args[0] === "message" && isMessageCommand(args[1])) {
    const target = args[2] === "--target" ? args[3] : undefined;
    if (args.length === 2 || (target && args.length === 4)) return { command: args[1], target };
  }
  throw new Error(
    "Usage: coforge message <check|read|send> | coforge attachment view <id> --output <path>",
  );
}

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  const invocation = parseArgs(args);
  if (invocation.command === "attachment-view") {
    const result = await transport.view(invocation.attachmentId);
    await Bun.write(invocation.output, result.bytes);
    return { attachmentId: invocation.attachmentId, path: invocation.output };
  }
  const { command, target } = invocation;
  if (command === "send")
    return transport.send(target, await new Response(Bun.stdin.stream()).text());
  return transport[command](target);
}

function isMessageCommand(value: string | undefined): value is MessageCommand {
  return value === "check" || value === "read" || value === "send";
}
