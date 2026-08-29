export type MessageCommand = "check" | "read" | "send";
export type MessageInvocation = { command: MessageCommand; target?: string };

export type MessageTransport = {
  check(target?: string): Promise<unknown>;
  read(target?: string): Promise<unknown>;
  send(target?: string, body?: string): Promise<unknown>;
};

export function parseArgs(args: readonly string[]): MessageInvocation {
  if (args[0] === "message" && isMessageCommand(args[1])) {
    const target = args[2] === "--target" ? args[3] : undefined;
    if (args.length === 2 || (target && args.length === 4)) return { command: args[1], target };
  }
  throw new Error("Usage: coforge message <check|read|send>");
}

export async function run(args: readonly string[], transport: MessageTransport): Promise<unknown> {
  const { command, target } = parseArgs(args);
  if (command === "send")
    return transport.send(target, await new Response(Bun.stdin.stream()).text());
  return transport[command](target);
}

function isMessageCommand(value: string | undefined): value is MessageCommand {
  return value === "check" || value === "read" || value === "send";
}
