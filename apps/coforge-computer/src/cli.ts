#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { homedir } from "os";
import { join } from "path";

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
import { ComputerSetup } from "./setup/computer-setup";
import { currentComputerPlatform } from "./platform";
import { FileMachineIdFallback, resolveMachineId } from "./machine-id";
import {
  CentrifugoComputerRegisterTransport,
  CentrifugoWorkspaceRpcTransport,
  cloudWebSocketEndpoint,
} from "./cloud-rpc-transport";
import { ComputerRegistrationClient } from "@coforge/protocol";
import { createDaemonHost, resolveDaemonExecutablePath } from "@coforge/daemon";
import { discoverExternalRuntimes } from "./runtime/inventory";
import { createTerminalWorkspacePicker, type WorkspacePickerKey } from "./workspace/picker";
import {
  createWorkspaceCatalogFromRpc,
  type ComputerWorkspaceRpcTransport,
} from "./workspace/catalog";
import { registrationIdempotencyKey } from "./registration/idempotency-key";
import { writeSetupResult } from "./cli/setup-output";
import { createCommand as createClientCommand } from "./daemon-client";
import { configureComputerLogger } from "./logging/computer-logger";
import { followComputerLogs } from "./logging/computer-logs";

const VERSION = "0.1.0";
const DEFAULT_SERVER_URL = "https://coforge.cn";
const DEFAULT_RELEASES_URL = "https://cdn.coforge.cn/releases/";
const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAv+p12qm4iWEzQxMHxwm3gMmm2J86UYuUEp4Viy115bA=
-----END PUBLIC KEY-----`;

function createWorkspacePickerKeyboard() {
  let onKey: ((key: WorkspacePickerKey) => void) | undefined;
  const input = process.stdin;
  const onData = (chunk: string | Uint8Array) => {
    const value = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (let index = 0; index < value.length; index += 1) {
      const sequence = value.slice(index);
      const key = sequence.startsWith("\x1b[A")
        ? "up"
        : sequence.startsWith("\x1b[B")
          ? "down"
          : sequence.startsWith("\x1b")
            ? "escape"
            : value[index] === "\r" || value[index] === "\n"
              ? "return"
              : value[index] === "q" || value[index] === "\u0003"
                ? "quit"
                : undefined;
      if (key) {
        index += key === "up" || key === "down" ? 2 : 0;
        onKey?.(key);
      }
    }
  };
  return {
    start(handler: (key: WorkspacePickerKey) => void) {
      onKey = handler;
      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
    },
    stop() {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      onKey = undefined;
    },
  };
}

export interface LoginCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export interface SetupCommand {
  run(
    workspaceSlug: string | undefined,
    options: { json: boolean; serverUrl?: string },
  ): Promise<void>;
}

export type SetupWorkspaceClient = Pick<
  OAuthDeviceClient,
  "listWorkspacesForServer" | "getWorkspaceForServer"
>;

export interface UpdateCommand {
  install(version: string): Promise<void>;
  upgrade(version: string): Promise<void>;
  rollback(): Promise<void>;
}

export interface DaemonCommand {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export interface LogsCommand {
  follow(): Promise<void>;
}

interface CliDependencies {
  login: LoginCommand;
  setup: SetupCommand;
  updater?: UpdateCommand;
  daemon?: DaemonCommand;
  logs?: LogsCommand;
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
    .option("--server <url>", "CoForge server URL", DEFAULT_SERVER_URL)
    .option("--workspace <slug>", "stable Workspace slug")
    .option("--json", "write one stable JSON result to stdout")
    .addHelpText("after", "\nExample:\n  $ coforge-computer setup --workspace my-workspace")
    .action((options: { workspace?: string; server: string; json?: boolean }, command: Command) => {
      setupSelected = true;
      json = options.json ?? false;
      return dependencies.setup.run(options.workspace, {
        serverUrl: command.getOptionValueSource("server") === "cli" ? options.server : undefined,
        json,
      });
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
  program
    .command("start")
    .description("Start the Daemon and all configured Workspace Workers.")
    .action(() => requireDaemon(dependencies).start());
  program
    .command("stop")
    .description("Stop the Daemon and all Workspace Workers.")
    .action(() => requireDaemon(dependencies).stop());
  program
    .command("restart")
    .description("Restart the Daemon and all configured Workspace Workers.")
    .action(() => requireDaemon(dependencies).restart());
  program
    .command("logs")
    .description("Follow the Computer log, including rotated log files.")
    .action(() => requireLogs(dependencies).follow());

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

function requireDaemon(dependencies: CliDependencies): DaemonCommand {
  if (!dependencies.daemon) throw new Error("Daemon coordinator is unavailable in this build");
  return dependencies.daemon;
}

function requireLogs(dependencies: CliDependencies): LogsCommand {
  if (!dependencies.logs) throw new Error("Computer logs are unavailable in this build");
  return dependencies.logs;
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

export function createSetupCommand(
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
  config: FileComputerConfig,
  client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
  }),
  workspaceClient:
    | SetupWorkspaceClient
    | ComputerWorkspaceRpcTransport = new CentrifugoWorkspaceRpcTransport(),
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
  const setup = new ComputerSetup({
    config,
    workspaceRoot: join(stateDirectory, "workspaces"),
    credentials,
    metadataProvider: {
      async get() {
        return {
          platform: platform.os,
          osVersion: process.version,
          computerVersion: VERSION,
          machineId: await resolveMachineId({
            platform: platform.os,
            fallback: new FileMachineIdFallback(join(stateDirectory, "machine-id")),
          }),
          runtimes: await discoverExternalRuntimes(),
        };
      },
    },
    idempotencyKeyProvider: { create: registrationIdempotencyKey },
    authenticate: {
      async authenticate(serverUrl, _json) {
        const login = new ComputerLogin({
          client,
          store: credentials,
          config,
          writeLine: io.stdout,
          writeProgressLine: io.stderr,
          suppressFinalResult: true,
          skipWorkspaceListing: true,
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
    catalog: createWorkspaceCatalogFromRpc(
      "listAccessible" in workspaceClient
        ? workspaceClient
        : {
            listAccessible: (serverUrl, credential) =>
              workspaceClient.listWorkspacesForServer(serverUrl, credential),
            getBySlug: (serverUrl, credential, slug) =>
              workspaceClient.getWorkspaceForServer(serverUrl, credential, slug),
          },
    ),
    registrationFactory: (serverUrl, credential) => ({
      register: (request) =>
        new ComputerRegistrationClient(
          new CentrifugoComputerRegisterTransport(
            cloudWebSocketEndpoint(serverUrl),
            credential.accessToken,
          ),
        ).register(request),
    }),
    launcher: (serverUrl) =>
      createDaemonLauncher(platform.os, installDirectory, stateDirectory, serverUrl),
    selectWorkspace:
      process.stdin.isTTY && process.stderr.isTTY
        ? createTerminalWorkspacePicker(createWorkspacePickerKeyboard())
        : async () => {
            throw setupError("SETUP_WORKSPACE_REQUIRED", "A Workspace is required for this setup.");
          },
  });
  return {
    async run(workspaceSlug, options) {
      const result = await setup.run({
        workspaceSlug,
        serverUrl: options.serverUrl,
        json: options.json,
      });
      writeSetupResult(io.stdout, result, options.json);
    },
  };
}

function createDaemonLauncher(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
) {
  return createDaemonHost({
    platform,
    executablePath: resolveDaemonExecutablePath({ installRoot: installDirectory, platform }),
    socketPath: resolveDaemonSocketPath({ platform, stateDirectory }),
    stateDirectory,
    cloudWebSocketEndpoint: cloudWebSocketEndpoint(serverUrl),
    homeDirectory: homedir(),
    uid: process.getuid?.() ?? 0,
  });
}

function createCommand(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
  logger?: import("@logtape/logtape").Logger,
): DaemonCommand {
  return createClientCommand({
    daemon: createDaemonLauncher(platform, installDirectory, stateDirectory, serverUrl),
    logger,
  });
}

function createLogsCommand(
  dataDirectory: string,
  io: { stdout: (line: string) => void },
): LogsCommand {
  return {
    follow: () => followComputerLogs({ dataDirectory, write: io.stdout }),
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

if (import.meta.main) {
  const io = {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  const computerDirectory = resolveComputerConfigDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const config = new FileComputerConfig(computerDirectory);
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
  const logging = await configureComputerLogger({
    dataDirectory: computerDirectory,
    version: VERSION,
  });
  try {
    process.exitCode = await runCli(
      Bun.argv.slice(2),
      {
        login: createLoginCommand(io, config),
        setup: createSetupCommand(io, config),
        updater: createUpdateCommand(io),
        daemon: createCommand(
          platform.os,
          installDirectory,
          stateDirectory,
          DEFAULT_SERVER_URL,
          logging.logger,
        ),
        logs: createLogsCommand(computerDirectory, io),
      },
      io,
    );
  } finally {
    await logging.close();
  }
}
