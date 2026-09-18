#!/usr/bin/env bun
import { run } from "../index";
import { connectLocal } from "./local-client";
import { CliError, renderCliError } from "./cli-error";
import { runGitHubCli, runGitHubCredentialHelper } from "./github-credential";
import { runGitPrepareCommitMsg } from "./git-prepare-commit-msg";
import { COFORGE_CLI_VERSION } from "./version";

export async function runAgentCli(args: readonly string[]): Promise<void> {
  // `coforge --version`/`-V` reports only the CLI carrier, unlike `coforge version`, which also
  // queries the live daemon for its own and the Computer's version (ADR 0036).
  if (args[0] === "--version" || args[0] === "-V") {
    console.log(COFORGE_CLI_VERSION);
    return;
  }

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
    if (args[0] === "git" && args[1] === "prepare-commit-msg") {
      // This hook must never fail the Agent's commit: any failure is one plain-language stderr
      // line, and the process always exits 0 regardless of what happened above.
      try {
        await runGitPrepareCommitMsg(args.slice(2), transport.githubCommitTrailers!);
      } catch (error) {
        console.error(
          `coforge: CoForge co-author trailer skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exitCode = 0;
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
