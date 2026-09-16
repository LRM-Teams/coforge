#!/usr/bin/env bun
import { run } from "../index";
import { connectLocal } from "./local-client";
import { CliError, renderCliError } from "./cli-error";
import { runGitHubCli, runGitHubCredentialHelper } from "./github-credential";

export async function runAgentCli(args: readonly string[]): Promise<void> {
  const transport = connectLocal(
    Bun.env.COFORGE_DAEMON_SOCKET ?? "",
    Bun.env.COFORGE_AGENT_CONTEXT ?? "",
    Bun.env.COFORGE_AGENT_PROXY_URL ?? "",
  );

  try {
    if (args[0] === "github" && args[1] === "credential") {
      const output = await runGitHubCredentialHelper(
        args[2],
        await Bun.stdin.text(),
        transport.githubCredential,
      );
      if (output) process.stdout.write(output);
      return;
    }
    if (args[0] === "github" && args[1] === "gh") {
      process.exitCode = await runGitHubCli(args.slice(2), transport.githubCredential);
      return;
    }
    const result = await run(args, transport);
    if (typeof result === "string") console.log(result);
    else if (result !== undefined) console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof CliError) console.error(renderCliError(error));
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await runAgentCli(Bun.argv.slice(2));
