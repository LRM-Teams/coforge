#!/usr/bin/env bun

import { Command, CommanderError } from "commander";

import { OAuthDeviceClient } from "./oauth-device-client";
import { ComputerLogin } from "./login";
import { CliError, loginError } from "./errors";
import { NativeCredentialStore } from "./credential-store";

const VERSION = "0.1.0";
const DEFAULT_SERVER_URL = "https://coforge.cn";

export interface LoginCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export interface SetupCommand {
  run(workspaceSlug?: string): Promise<void>;
}

export async function runCli(
  args: readonly string[],
  dependencies: { login: LoginCommand; setup: SetupCommand },
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
): Promise<number> {
  let json = false;
  let loginSelected = false;
  const program = new Command()
    .name("coforge-computer")
    .description("Connect this machine to CoForge so code agents can run here.")
    .version(VERSION, "-V, --version")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride();
  program
    .command("login")
    .description("Sign in to CoForge and list accessible Workspaces.")
    .option("--server <url>", "CoForge server URL", DEFAULT_SERVER_URL)
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { server: string; json?: boolean }) => {
      loginSelected = true;
      json = options.json ?? false;
      return dependencies.login.run(options.server, { json });
    });
  program
    .command("setup")
    .description("Create or restore one Workspace binding on this Computer.")
    .argument("[workspace-slug]", "stable Workspace slug; omit to choose interactively")
    .addHelpText("after", "\nExample:\n  $ coforge-computer setup my-workspace")
    .action((workspaceSlug?: string) => dependencies.setup.run(workspaceSlug));

  if (args.length === 0) {
    program.outputHelp();
    return 2;
  }
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return error.exitCode;
    }
    const failure =
      error instanceof CliError
        ? error
        : loginSelected
          ? loginError("AUTH_FAILED", "Login failed.")
          : null;
    if (failure) {
      if (json) {
        io.stdout(
          JSON.stringify({
            ok: false,
            error: { code: failure.code, message: failure.message, hint: failure.hint },
          }),
        );
      } else {
        io.stderr(`${failure.code}: ${failure.message}\nHint: ${failure.hint}`);
      }
    } else {
      io.stderr(error instanceof Error ? error.message : "coforge-computer failed");
    }
    return 1;
  }
  return 0;
}

function createLoginCommand(io: {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): LoginCommand {
  const login = new ComputerLogin({
    client: new OAuthDeviceClient({
      clientId: "coforge-computer",
      scope: "openid offline_access",
    }),
    store: new NativeCredentialStore(),
    writeLine: io.stdout,
    writeProgressLine: io.stderr,
    sleep: Bun.sleep,
  });
  return {
    async run(serverUrl, options) {
      await login.run({ serverUrl, json: options.json });
    },
  };
}

function createSetupCommand(): SetupCommand {
  return {
    async run() {
      throw new Error("Workspace setup is waiting for the reviewed binding protocol");
    },
  };
}

if (import.meta.main) {
  const io = {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  process.exitCode = await runCli(
    Bun.argv.slice(2),
    { login: createLoginCommand(io), setup: createSetupCommand() },
    io,
  );
}
