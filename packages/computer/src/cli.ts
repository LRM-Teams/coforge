#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { homedir } from "os";
import { join } from "path";

import { OAuthDeviceClient } from "./oauth-device-client";
import { ComputerLogin } from "./login";
import { CliError, loginError, safeErrorDetail, setupError } from "./errors";
import { FileCredentialStore } from "./credential-store";
import {
  resolveComputerBinaryDirectory,
  resolveComputerInstallDirectory,
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "./paths";
import { ComputerUpdater, UpdateError } from "./updater";
import { launchUpgradeCoordinator } from "./release/upgrade-coordinator";
import { COFORGE_RELEASE_FEED_URL, COFORGE_SERVER_URL } from "./release-channel";
import { FileComputerConfig, loadBuildProfile } from "./local-config";
import { resolveComputerConfigDirectory } from "./paths";
import { ComputerSetup } from "./setup/computer-setup";
import { currentComputerPlatform } from "./platform";
import { FileMachineIdFallback, resolveMachineId } from "./machine-id";
import {
  CentrifugoComputerRegisterTransport,
  CentrifugoWorkspaceRpcTransport,
  resolveCentrifugoWebSocketEndpoint,
  resolveDaemonConnectionEndpoint,
} from "./cloud-rpc-transport";
import { ComputerRegistrationClient } from "@coforge/protocol";
import {
  createDaemonHost,
  resolveDaemonExecutablePath,
  runMachineSupervisor,
} from "@coforge/daemon";
import { createWorkspaceLookup } from "./workspace/lookup";
import { isValidComputerWorkspaceSlug } from "./workspace/workspace-slug";
import { registrationIdempotencyKey } from "./registration/idempotency-key";
import { writeSetupResult } from "./cli/setup-output";
import { createCommand as createClientCommand } from "./daemon-client";
import { configureComputerLogger } from "./logging/computer-logger";
import { followComputerLogs } from "./logging/computer-logs";
import computerPackage from "../package.json";

const VERSION = Bun.env.COFORGE_COMPUTER_VERSION ?? computerPackage.version;

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

export interface DaemonCommand {
  start(workspace?: string): Promise<void>;
  stop(workspace?: string): Promise<void>;
  restart(workspace?: string): Promise<void>;
}

export interface LogsCommand {
  follow(): Promise<void>;
}

export interface ForegroundCommand {
  run(): Promise<void>;
}

interface CliDependencies {
  login: LoginCommand;
  setup: SetupCommand;
  updater?: UpdateCommand;
  daemon?: DaemonCommand;
  logs?: LogsCommand;
  foreground?: ForegroundCommand;
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
    .description("Sign in to CoForge without selecting a Workspace.")
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean }) => {
      loginSelected = true;
      json = options.json ?? false;
      return dependencies.login.run(COFORGE_SERVER_URL, { json });
    });
  program
    .command("setup")
    .description("Register this Computer with the selected Workspace and start its Daemon.")
    .option(
      "--workspace <slug>",
      "Workspace slug to join (falls back to COFORGE_SETUP_INTENT when omitted)",
    )
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean; workspace?: string }) => {
      setupSelected = true;
      json = options.json ?? false;
      const workspaceSlug = resolveSetupWorkspace(options.workspace);
      if (workspaceSlug !== undefined && !isValidComputerWorkspaceSlug(workspaceSlug)) {
        throw setupError(
          "SETUP_WORKSPACE_INVALID",
          `Workspace slug '${workspaceSlug}' is not valid.`,
          "workspace-lookup",
        );
      }
      return dependencies.setup.run(workspaceSlug, { json });
    });
  for (const operation of ["install", "upgrade"] as const) {
    program
      .command(operation)
      .description(
        operation === "install"
          ? "Install one verified Computer version for the current user."
          : "Atomically upgrade to one verified Computer version.",
      )
      .option("--version <selector>", "latest|<version>", "latest")
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
    .description("Start the Daemon and all configured Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .action((options: { workspace?: string }) =>
      requireDaemon(dependencies).start(options.workspace),
    );
  program
    .command("stop")
    .description("Stop the Daemon and all Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .action((options: { workspace?: string }) =>
      requireDaemon(dependencies).stop(options.workspace),
    );
  program
    .command("restart")
    .description("Restart the Daemon and all configured Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .action((options: { workspace?: string }) =>
      requireDaemon(dependencies).restart(options.workspace),
    );
  program
    .command("foreground")
    .description("Run the Daemon supervisor in the foreground for external supervision.")
    .action(() => requireForeground(dependencies).run());
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
    // The login branch carries the underlying cause. Without it every unmapped login failure - a
    // server with no device endpoint, a DNS failure, a malformed discovery document - collapses
    // into one indistinguishable "Login failed." under a fixed hint about server configuration
    // that is unrelated to most of them, leaving nothing to diagnose from.
    // safeErrorDetail strips anything token-shaped out of the message.
    const failure =
      error instanceof CliError
        ? error
        : loginSelected
          ? loginError("AUTH_FAILED", `Login failed: ${safeErrorDetail(error)}`)
          : setupSelected
            ? setupError("SETUP_FAILED", "Workspace setup failed.", "computer-registration", error)
            : null;
    if (failure) {
      if (json) {
        io.stdout(
          JSON.stringify({
            ok: false,
            error: {
              code: failure.code,
              message: failure.message,
              hint: failure.hint,
            },
          }),
        );
      } else {
        io.stderr(`${failure.code}: ${failure.message}\nHint: ${failure.hint}`);
      }
    } else if (error instanceof CliError) {
      io.stderr(`${error.code}: ${error.message}\nHint: ${error.hint}`);
    } else if (error instanceof UpdateError) {
      io.stderr(`${error.code}: ${error.message}`);
    } else {
      io.stderr(error instanceof Error ? error.message : "coforge-computer failed");
    }
    return 1;
  }
  return 0;
}

/** `--workspace` wins when the user supplies it explicitly; the setup-intent environment
 * variable is a fallback source, not a second required input. A blank `--workspace ""`
 * counts as supplied (and is later rejected as invalid) rather than falling through. */
function resolveSetupWorkspace(cliWorkspace: string | undefined): string | undefined {
  return cliWorkspace !== undefined ? cliWorkspace : readSetupIntentWorkspace();
}

/** e2e/automation bootstrap bypass: production install flows never set this env var, so the
 * normal path is the explicit `--workspace <slug>` flag above. */
function readSetupIntentWorkspace(): string | undefined {
  const raw = process.env.COFORGE_SETUP_INTENT;
  if (!raw) return undefined;
  try {
    const intent: unknown = JSON.parse(raw);
    if (typeof intent === "object" && intent !== null && "workspaceSlug" in intent) {
      const slug = (intent as { workspaceSlug?: unknown }).workspaceSlug;
      return typeof slug === "string" && slug.length > 0 ? slug : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
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

function requireForeground(dependencies: CliDependencies): ForegroundCommand {
  if (!dependencies.foreground)
    throw new Error("Foreground supervisor is unavailable in this build");
  return dependencies.foreground;
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
    store: new FileCredentialStore(),
    config,
    writeLine: io.stdout,
    writeProgressLine: io.stderr,
    sleep: Bun.sleep,
  });
  return {
    async run(serverUrl, options) {
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
      try {
        await createDaemonLauncher(
          platform.os,
          installDirectory,
          stateDirectory,
          serverUrl,
        ).preflight?.();
      } catch {
        throw loginError(
          "AUTH_DAEMON_PREFLIGHT_FAILED",
          "Could not verify the local Daemon environment. Login was not started.",
        );
      }
      await loadBuildProfile(config, serverUrl, "login");
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
): SetupCommand {
  const credentials = new FileCredentialStore();
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
        };
      },
    },
    idempotencyKeyProvider: { create: registrationIdempotencyKey },
    authenticate: {
      async authenticate(serverUrl, json) {
        const login = new ComputerLogin({
          client,
          store: credentials,
          config,
          writeLine: io.stdout,
          writeProgressLine: io.stderr,
          suppressFinalResult: true,
          sleep: Bun.sleep,
        });
        await login.run({ serverUrl, json });
        const credential = await credentials.load(serverUrl);
        if (!credential)
          throw setupError(
            "SETUP_NOT_LOGGED_IN",
            "Device authorization did not produce credentials.",
          );
        return credential;
      },
    },
    workspaceLookup: createWorkspaceLookup(
      new CentrifugoWorkspaceRpcTransport(undefined, resolveCentrifugoWebSocketEndpoint),
    ),
    registrationFactory: (serverUrl, credential) => ({
      register: (request) =>
        new ComputerRegistrationClient(
          new CentrifugoComputerRegisterTransport(
            resolveCentrifugoWebSocketEndpoint(serverUrl),
            credential.accessToken,
          ),
        ).register(request),
    }),
    launcher: (serverUrl) =>
      createDaemonLauncher(platform.os, installDirectory, stateDirectory, serverUrl),
    serverUrl: COFORGE_SERVER_URL,
  });
  return {
    async run(workspaceSlug, options) {
      const result = await setup.run({
        workspaceSlug,
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
    executablePath:
      process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1" && process.env.COFORGE_E2E_DAEMON_EXECUTABLE
        ? process.env.COFORGE_E2E_DAEMON_EXECUTABLE
        : resolveDaemonExecutablePath({ installRoot: installDirectory, platform }),
    socketPath: resolveDaemonSocketPath({ platform, stateDirectory }),
    stateDirectory,
    serverUrl,
    daemonConnectionEndpoint:
      process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1" &&
      process.env.COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT
        ? process.env.COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT
        : resolveDaemonConnectionEndpoint(serverUrl),
    homeDirectory: homedir(),
    uid: process.getuid?.() ?? 0,
  });
}

function createCommand(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
  config: FileComputerConfig,
  logger?: import("@logtape/logtape").Logger,
): DaemonCommand {
  const launcher = createDaemonLauncher(platform, installDirectory, stateDirectory, serverUrl);
  const command = createClientCommand({
    daemon: launcher,
    logger,
    resolveWorkspace: async (selector) => {
      const config = new FileComputerConfig(
        resolveComputerConfigDirectory({
          platform,
          homeDirectory: homedir(),
          environment: Bun.env,
        }),
      );
      const binding = await config.loadRegistration(selector);
      if (!binding) throw new Error(`Workspace '${selector}' is not registered locally`);
      return binding.id;
    },
  });
  return {
    async start(workspace) {
      await launcher.preflight?.();
      await loadBuildProfile(config, serverUrl, "daemon");
      await command.start(workspace);
    },
    stop: (workspace) => command.stop(workspace),
    async restart(workspace) {
      await launcher.preflight?.();
      await loadBuildProfile(config, serverUrl, "daemon");
      await command.restart(workspace);
    },
  };
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
    baseUrl: COFORGE_RELEASE_FEED_URL,
    target,
    installRoot,
    binaryDirectory,
  });
  const supervisorStatePath = resolveComputerStateDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: Bun.env,
  });
  const coordinate = (operation: "upgrade" | "rollback", selection: string) =>
    launchUpgradeCoordinator({
      operation,
      selection,
      installRoot,
      binaryDirectory,
      target,
      baseUrl: COFORGE_RELEASE_FEED_URL,
      supervisorStatePath,
      supervisorSocketPath: resolveDaemonSocketPath({
        platform: process.platform,
        stateDirectory: supervisorStatePath,
      }),
    });
  return {
    async install(version) {
      const result = (await Bun.file(join(installRoot, "active.json")).exists())
        ? await coordinate("upgrade", version)
        : await updater.install(version);
      io.stdout(`Installed ${result.version}`);
    },
    async upgrade(version) {
      const result = await coordinate("upgrade", version);
      io.stdout(`Activated ${result.version}`);
    },
    async rollback() {
      const result = await coordinate("rollback", "latest");
      io.stdout(`Rolled back to ${result.version}`);
    },
  };
}

export async function runComputer(): Promise<void> {
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
          COFORGE_SERVER_URL,
          config,
          logging.logger,
        ),
        logs: createLogsCommand(computerDirectory, io),
        foreground: {
          run: () =>
            runMachineSupervisor([
              "--socket",
              resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
              "--state-directory",
              stateDirectory,
            ]),
        },
      },
      io,
    );
  } finally {
    await logging.close();
  }
}
