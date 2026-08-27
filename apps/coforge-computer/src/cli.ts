#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";

import { OAuthDeviceClient } from "./oauth-device-client";
import { ComputerLogin } from "./login";
import { CliError, loginError, setupError } from "./errors";
import { NativeCredentialStore } from "./credential-store";
import { resolveComputerBinaryDirectory, resolveComputerInstallDirectory } from "./paths";
import { ComputerUpdater, UpdateError } from "./updater";
import { FileComputerConfig } from "./local-config";
import { resolveComputerConfigDirectory } from "./paths";
import { ComputerSetup } from "./setup";
import { terminalText } from "./terminal-output";
import type { AccessibleWorkspace } from "./login";

const VERSION = "0.1.0";
const DEFAULT_SERVER_URL = "https://coforge.cn";
const DEFAULT_RELEASES_URL = "https://cdn.coforge.cn/releases/";
const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAv+p12qm4iWEzQxMHxwm3gMmm2J86UYuUEp4Viy115bA=
-----END PUBLIC KEY-----`;

export interface LoginCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export interface SetupCommand {
  run(workspaceSlug: string | undefined, options: { json: boolean }): Promise<void>;
}

export interface UpdateCommand {
  install(version: string): Promise<void>;
  upgrade(version: string): Promise<void>;
  rollback(): Promise<void>;
}

interface CliDependencies {
  login: LoginCommand;
  setup: SetupCommand;
  updater?: UpdateCommand;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
): Promise<number> {
  let json = false;
  let loginSelected = false;
  let setupSelected = false;
  const program = new Command()
    .name("coforge-computer")
    .description("Connect this machine to CoForge so code agents can run here.")
    .version(VERSION, "-V, --cli-version", "output the Computer CLI version")
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
    .description("Configure one accessible Workspace for this Computer.")
    .argument("[workspace-slug]", "stable Workspace slug; omit to choose interactively")
    .option("--json", "write one stable JSON result to stdout")
    .addHelpText("after", "\nExample:\n  $ coforge-computer setup my-workspace")
    .action((workspaceSlug: string | undefined, options: { json?: boolean }) => {
      setupSelected = true;
      json = options.json ?? false;
      return dependencies.setup.run(workspaceSlug, { json });
    });
  for (const operation of ["install", "upgrade"] as const) {
    program
      .command(operation)
      .description(
        operation === "install"
          ? "Install one verified Computer release set for the current user."
          : "Atomically upgrade to one verified Computer release set.",
      )
      .option("--version <selector>", "latest, test, or an exact sha256 release-set id", "latest")
      .action((options: { version: string }) => {
        const updater = requireUpdater(dependencies);
        return updater[operation](options.version);
      });
  }
  program
    .command("rollback")
    .description("Reactivate the previous locally verified Computer bundle without network access.")
    .action(() => requireUpdater(dependencies).rollback());

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
          : setupSelected
            ? setupError("SETUP_FAILED", "Workspace setup failed.")
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
    } else if (error instanceof UpdateError) {
      io.stderr(`${error.code}: ${error.message}`);
    } else {
      io.stderr(error instanceof Error ? error.message : "coforge-computer failed");
    }
    return 1;
  }
  return 0;
}

function requireUpdater(dependencies: CliDependencies): UpdateCommand {
  if (!dependencies.updater) throw new Error("Updater is unavailable in this build");
  return dependencies.updater;
}

function createLoginCommand(
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  },
  config: FileComputerConfig,
): LoginCommand {
  const login = new ComputerLogin({
    client: new OAuthDeviceClient({
      clientId: "coforge-computer",
      scope: "openid offline_access",
    }),
    store: new NativeCredentialStore(),
    config,
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

function createSetupCommand(
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
  config: FileComputerConfig,
): SetupCommand {
  const credentials = new NativeCredentialStore();
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
  });
  const setup = new ComputerSetup({
    config,
    credentials,
    client: {
      listWorkspaces: (serverUrl, credential) =>
        client.listWorkspacesForServer(serverUrl, credential),
    },
    selectWorkspace: (workspaces) => selectWorkspaceInteractively(workspaces, io.stderr),
    writeLine: io.stdout,
  });
  return {
    async run(workspaceSlug, options) {
      await setup.run({ workspaceSlug, json: options.json });
    },
  };
}

function createUpdateCommand(io: { stdout: (line: string) => void }): UpdateCommand {
  const installRoot = resolveComputerInstallDirectory({
    platform: process.platform,
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? "",
    environment: process.env,
  });
  const binaryDirectory = resolveComputerBinaryDirectory({
    platform: process.platform,
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? "",
    environment: process.env,
  });
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const updater = new ComputerUpdater({
    baseUrl: DEFAULT_RELEASES_URL,
    trustedKeys: { "coforge-release-unprovisioned": RELEASE_KEY },
    target,
    installRoot,
    binaryDirectory,
  });
  return {
    async install(version) {
      const result = await updater.install(version);
      io.stdout(`Installed ${result.releaseSet}`);
    },
    async upgrade(version) {
      const result = await updater.install(version);
      io.stdout(`Activated ${result.releaseSet}`);
    },
    async rollback() {
      const result = await updater.rollback();
      io.stdout(`Rolled back to ${result.releaseSet}`);
    },
  };
}

async function selectWorkspaceInteractively(
  workspaces: AccessibleWorkspace[],
  writePrompt: (line: string) => void,
): Promise<AccessibleWorkspace> {
  writePrompt("Choose one Workspace:");
  for (const [index, workspace] of workspaces.entries()) {
    writePrompt(
      `  ${index + 1}) ${terminalText(workspace.name)} (${terminalText(workspace.slug)})`,
    );
  }
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await input.question("Selection: ");
    const selectedIndex = Number(answer) - 1;
    const workspace = Number.isInteger(selectedIndex) ? workspaces[selectedIndex] : undefined;
    if (!workspace) {
      throw setupError("SETUP_SELECTION_INVALID", "The Workspace selection is invalid.");
    }
    return workspace;
  } finally {
    input.close();
  }
}

if (import.meta.main) {
  const io = {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  const config = new FileComputerConfig(
    resolveComputerConfigDirectory({
      platform: process.platform,
      homeDirectory: homedir(),
      environment: process.env,
    }),
  );
  process.exitCode = await runCli(
    Bun.argv.slice(2),
    {
      login: createLoginCommand(io, config),
      setup: createSetupCommand(io, config),
      updater: createUpdateCommand(io),
    },
    io,
  );
}
