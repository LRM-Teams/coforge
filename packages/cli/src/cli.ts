#!/usr/bin/env bun
import { run, type MessageTransport } from "../index";
import { connectLocal } from "./local-client";

const transport: MessageTransport = connectLocal(
  Bun.env.COFORGE_DAEMON_SOCKET ?? "",
  Bun.env.COFORGE_AGENT_CONTEXT ?? "",
  Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
);

try {
  const result = await run(Bun.argv.slice(2), transport);
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
