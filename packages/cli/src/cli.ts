#!/usr/bin/env bun
import { run, type MessageTransport } from "../index";
import { connectLocal } from "./local-client";

export async function runAgentCli(args: readonly string[]): Promise<void> {
  const transport: MessageTransport = connectLocal(
    Bun.env.COFORGE_DAEMON_SOCKET ?? "",
    Bun.env.COFORGE_AGENT_CONTEXT ?? "",
    Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
  );

  try {
    const result = await run(args, transport);
    if (typeof result === "string") console.log(result);
    else if (result !== undefined) console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await runAgentCli(Bun.argv.slice(2));
