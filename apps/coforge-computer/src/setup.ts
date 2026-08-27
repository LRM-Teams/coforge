import type { AccessibleWorkspace, Credential } from "./login";
import type { ComputerConfig } from "./local-config";
import { CliError, setupError } from "./errors";
import { terminalText } from "./terminal-output";
import type { ComputerRegisterRequest, ComputerRegistrationClient } from "@coforge/protocol";
import type { DaemonLauncher } from "@coforge/daemon";
import { currentComputerPlatform } from "./platform";

export interface SetupCredentialStore {
  load(serverUrl: string): Promise<Credential | null>;
  saveDaemonCredential?(serverUrl: string, credential: string): Promise<void>;
}

export interface SetupRegistration {
  register(request: ComputerRegisterRequest): ReturnType<ComputerRegistrationClient["register"]>;
}

export interface SetupAuthenticator {
  authenticate(serverUrl: string, json: boolean): Promise<Credential>;
}

export interface SetupWorkspaceClient {
  /** Interactive-only RPC seam. This is not an HTTP/business REST client. */
  listWorkspaces(serverUrl: string, credential: Credential): Promise<AccessibleWorkspace[]>;
}

export type ComputerSetupOptions = {
  config: Pick<
    ComputerConfig,
    "loadCurrentProfile" | "saveWorkspace" | "saveRegistration" | "discardRegistration"
  >;
  credentials: SetupCredentialStore;
  authenticate?: SetupAuthenticator;
  client: SetupWorkspaceClient;
  registration?: SetupRegistration;
  registrationFactory?: (serverUrl: string, credential: Credential) => SetupRegistration;
  launcher?: DaemonLauncher;
  machineIdProvider?: () => Promise<string>;
  selectWorkspace?: (workspaces: AccessibleWorkspace[]) => Promise<AccessibleWorkspace>;
  writeLine: (line: string) => void;
};

export class ComputerSetup {
  constructor(private readonly options: ComputerSetupOptions) {}

  async run(input: { workspaceSlug?: string; json?: boolean }): Promise<{
    workspace: AccessibleWorkspace;
    configPath: string;
  }> {
    const profile = await this.loadProfile();
    const credential =
      (await this.options.credentials.load(profile.serverUrl)) ??
      (this.options.authenticate
        ? await this.options.authenticate.authenticate(profile.serverUrl, input.json ?? false)
        : null);
    if (!credential)
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");

    let workspace: AccessibleWorkspace;
    if (input.workspaceSlug) {
      // The server resolves the slug as part of computer:register. There is
      // deliberately no REST/business lookup in this path.
      workspace = { id: "", slug: input.workspaceSlug, name: input.workspaceSlug };
    } else {
      if (input.json || !this.options.selectWorkspace) {
        throw setupError("SETUP_WORKSPACE_REQUIRED", "A Workspace is required for this setup.");
      }
      const workspaces = await this.options.client.listWorkspaces(profile.serverUrl, credential);
      if (workspaces.length === 0) {
        throw setupError("SETUP_WORKSPACE_NOT_FOUND", "No accessible Workspace was found.");
      }
      workspace = await this.options.selectWorkspace(workspaces);
    }

    let configPath: string;
    let registeredRegistration:
      | Parameters<NonNullable<ComputerConfig["discardRegistration"]>>[0]
      | undefined;
    try {
      if (
        (this.options.registration || this.options.registrationFactory) &&
        this.options.launcher &&
        this.options.config.saveRegistration
      ) {
        const machineId = this.options.machineIdProvider
          ? await this.options.machineIdProvider()
          : (() => {
              throw setupError("SETUP_FAILED", "A stable machine identity is unavailable.");
            })();
        const registration =
          this.options.registration ??
          this.options.registrationFactory?.(profile.serverUrl, credential);
        if (!registration)
          throw setupError(
            "SETUP_REGISTRATION_UNAVAILABLE",
            "Registration transport is unavailable.",
          );
        const response = await registration.register({
          protocolMajor: 1,
          requestId: stableRegistrationKey(
            profile.serverUrl,
            input.workspaceSlug ?? workspace.slug,
          ),
          workspaceSlug: workspace.slug,
          machineId,
          platform: currentComputerPlatform().os,
          osVersion: process.version,
          computerVersion: "0.1.0",
          runtimes: [],
          registrationIdempotencyKey: stableRegistrationKey(
            profile.serverUrl,
            `${input.workspaceSlug ?? workspace.slug}:${machineId}`,
          ),
        });
        workspace = { id: response.workspaceId, slug: workspace.slug, name: workspace.name };
        registeredRegistration = {
          id: response.workspaceId,
          slug: workspace.slug,
          computerId: response.computerId,
          connectionId: response.connectionId,
        };
        // Start first: the Daemon must accept its credential before local
        // configuration advertises this registration as usable.
        await this.options.launcher.ensureStarted(response.daemonWorkspaceCredential);
        configPath = await this.options.config.saveRegistration(
          registeredRegistration,
          response.daemonWorkspaceCredential,
        );
        if (!this.options.credentials.saveDaemonCredential) {
          throw setupError(
            "SETUP_REGISTRATION_UNAVAILABLE",
            "Secure Daemon credential storage is unavailable.",
          );
        }
        await this.options.credentials.saveDaemonCredential(
          profile.serverUrl,
          response.daemonWorkspaceCredential,
        );
      } else {
        throw setupError(
          "SETUP_REGISTRATION_UNAVAILABLE",
          "Computer registration is not available in this build yet.",
        );
      }
    } catch (error) {
      if (registeredRegistration) {
        try {
          await this.options.config.discardRegistration?.(registeredRegistration);
        } catch {
          // Preserve the setup failure; cleanup is best effort.
        }
      }
      if (error instanceof CliError) throw error;
      throw setupError("SETUP_CONFIG_WRITE_FAILED", "Could not save the Workspace configuration.");
    }

    if (input.json) {
      this.options.writeLine(
        JSON.stringify({
          ok: true,
          workspace,
          config_path: configPath,
          server_registration_created: true,
          daemon_started: true,
        }),
      );
    } else {
      this.options.writeLine("CoForge Computer setup complete");
      this.options.writeLine(
        `Workspace:             ${terminalText(workspace.name)} (${terminalText(workspace.slug)})`,
      );
      this.options.writeLine(`Configuration saved:   ${terminalText(configPath)}`);
      this.options.writeLine("Computer:              registered");
      this.options.writeLine("Daemon:                started");
    }
    return { workspace, configPath };
  }

  private async loadProfile(): Promise<{ serverUrl: string }> {
    try {
      return await this.options.config.loadCurrentProfile();
    } catch {
      throw setupError("SETUP_NOT_LOGGED_IN", "No current login profile was found.");
    }
  }
}

function stableRegistrationKey(serverUrl: string, value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${serverUrl}\0${value}`);
  return hasher.digest("hex");
}
