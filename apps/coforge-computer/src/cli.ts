#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import { OAuthDeviceClient } from "./oauth-device-client";
import { ComputerLogin } from "./login";
import { CliError, loginError, setupError } from "./errors";
import { NativeCredentialStore } from "./credential-store";
import {
  resolveComputerBinaryDirectory,
  resolveComputerInstallDirectory,
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "./paths";
import { ComputerUpdater, UpdateError } from "./updater";
import { FileComputerConfig } from "./local-config";
import { resolveComputerConfigDirectory } from "./paths";
import { ComputerSetup } from "./setup";
import { terminalText } from "./terminal-output";
import type { AccessibleWorkspace } from "./login";
import { currentComputerPlatform } from "./platform";
import { FileMachineIdFallback, resolveMachineId } from "./machine-id";
import { CentrifugoComputerRegisterTransport, cloudWebSocketEndpoint } from "./cloud-rpc-transport";
import { ComputerRegistrationClient } from "@coforge/protocol";
import { createDaemonHost, resolveDaemonExecutablePath } from "@coforge/daemon";

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
    .option("--workspace <slug>", "stable Workspace slug")
    .option("--json", "write one stable JSON result to stdout")
    .addHelpText("after", "\nExample:\n  $ coforge-computer setup --workspace my-workspace")
    .action((options: { workspace?: string; json?: boolean }) => {
      setupSelected = true;
      json = options.json ?? false;
      return dependencies.setup.run(options.workspace, { json });
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
  const platform = currentComputerPlatform();
  const stateDirectory = resolveComputerStateDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const installDirectory = resolveComputerInstallDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
  });
  const setup = new ComputerSetup({
    config,
    credentials,
    machineIdProvider: () =>
      resolveMachineId({
        platform: platform.os,
        fallback: new FileMachineIdFallback(join(stateDirectory, "machine-id")),
      }),
    authenticate: {
      async authenticate(serverUrl, _json) {
        const login = new ComputerLogin({
          client,
          store: credentials,
          config,
          writeLine: io.stdout,
          writeProgressLine: io.stderr,
          suppressFinalResult: true,
          sleep: Bun.sleep,
        });
        await login.run({ serverUrl, json: false });
        const credential = await credentials.load(serverUrl);
        if (!credential)
          throw setupError(
            "SETUP_NOT_LOGGED_IN",
            "Device authorization did not produce credentials.",
          );
        return credential;
      },
    },
    // The production workspace:list RPC transport is not approved/available
    // yet. Never substitute the OAuth HTTP client here.
    client: {
      listWorkspaces: async () => {
        throw setupError(
          "SETUP_REGISTRATION_UNAVAILABLE",
          "Workspace listing RPC is unavailable in this build.",
        );
      },
    },
    registrationFactory: (serverUrl, credential) => ({
      register: (request) =>
        new ComputerRegistrationClient(
          new CentrifugoComputerRegisterTransport(
            cloudWebSocketEndpoint(serverUrl),
            credential.accessToken,
          ),
        ).register(request),
    }),
    launcher:
      platform.os === "darwin"
        ? createDaemonHost({
            platform: platform.os,
            executablePath: resolveDaemonExecutablePath({
              installRoot: installDirectory,
              platform: platform.os,
            }),
            socketPath: resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
            homeDirectory: homedir(),
            uid: process.getuid?.() ?? 0,
          })
        : createDaemonHost({
            platform: platform.os,
            executablePath: resolveDaemonExecutablePath({
              installRoot: installDirectory,
              platform: platform.os,
            }),
            socketPath: resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
            homeDirectory: homedir(),
            uid: process.getuid?.() ?? 0,
          }),
    selectWorkspace:
      process.stdin.isTTY && process.stderr.isTTY
        ? (workspaces) => selectWorkspaceInteractively(workspaces)
        : undefined,
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
  const target = currentComputerPlatform().releaseTarget;
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
): Promise<AccessibleWorkspace> {
  const input = process.stdin;
  const output = process.stderr;
  let selectedIndex = 0;
  const lineCount = workspaces.length + 2;

  return await new Promise((resolve, reject) => {
    const render = (initial = false) => {
      if (!initial) output.write(`\x1b[${lineCount}A`);
      output.write("\x1b[2KChoose a Workspace:\n");
      for (const [index, workspace] of workspaces.entries()) {
        const marker = index === selectedIndex ? "❯" : " ";
        output.write(
          `\x1b[2K${marker} ${terminalText(workspace.name)} (${terminalText(workspace.slug)})\n`,
        );
      }
      output.write("\x1b[2KUse ↑/↓ to move, Enter to select, Esc to cancel\n");
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
      input.pause();
    };
    const onKeypress = (_character: string, key: { name?: string; sequence?: string }) => {
      if (key.name === "up")
        selectedIndex = (selectedIndex - 1 + workspaces.length) % workspaces.length;
      else if (key.name === "down") selectedIndex = (selectedIndex + 1) % workspaces.length;
      else if (key.name === "return") {
        const workspace = workspaces[selectedIndex];
        if (!workspace) return;
        cleanup();
        resolve(workspace);
        return;
      } else if (key.name === "escape" || key.name === "q" || key.sequence === "\u0003") {
        cleanup();
        reject(setupError("SETUP_WORKSPACE_NOT_FOUND", "Workspace selection was cancelled."));
        return;
      } else return;
      render();
    };

    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on("keypress", onKeypress);
    render(true);
  });
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
