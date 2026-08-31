import type { AccessibleWorkspace, Credential } from "../login";
import type { ComputerConfig } from "../local-config";
import { CliError, setupError } from "../errors";
import type { ComputerRegisterRequest, ComputerRegistrationClient } from "@coforge/protocol";
import type { DaemonLauncher } from "@coforge/daemon";
import type { WorkspaceLookup } from "../workspace/lookup";

export type ComputerPlatformName = "darwin" | "linux" | "win32";

export type SetupResult = { workspace: AccessibleWorkspace; configPath: string };
const DEFAULT_SERVER_URL = "https://coforge.cn";

export interface ComputerMetadataProvider {
  get(): Promise<{
    platform: ComputerPlatformName;
    osVersion: string;
    computerVersion: string;
    machineId: string;
    runtimes: ComputerRegisterRequest["runtimes"];
  }>;
}

export interface RegistrationIdempotencyKeyProvider {
  create(serverUrl: string, value: string): string;
}

export interface SetupCredentialStore {
  load(serverUrl: string): Promise<Credential | null>;
}

export interface SetupRegistration {
  register(request: ComputerRegisterRequest): ReturnType<ComputerRegistrationClient["register"]>;
}

export interface SetupAuthenticator {
  authenticate(serverUrl: string, json: boolean): Promise<Credential>;
}

export type ComputerSetupOptions = {
  config: Pick<ComputerConfig, "loadCurrentProfile"> &
    Partial<Pick<ComputerConfig, "saveCurrentProfile">> &
    Required<Pick<ComputerConfig, "saveRegistration" | "discardRegistration">> &
    Partial<Pick<ComputerConfig, "loadRegistration">>;
  credentials: SetupCredentialStore;
  authenticate?: SetupAuthenticator;
  workspaceLookup: WorkspaceLookup;
  registrationFactory: (serverUrl: string, credential: Credential) => SetupRegistration;
  launcher: DaemonLauncher | ((serverUrl: string) => DaemonLauncher);
  metadataProvider: ComputerMetadataProvider;
  idempotencyKeyProvider: RegistrationIdempotencyKeyProvider;
  workspaceRoot: string;
};

export class ComputerSetup {
  constructor(private readonly options: ComputerSetupOptions) {}

  async run(input: {
    workspaceSlug?: string;
    serverUrl?: string;
    json?: boolean;
  }): Promise<SetupResult> {
    const profile = await this.loadProfile();
    const serverUrl = input.serverUrl ?? profile?.serverUrl ?? DEFAULT_SERVER_URL;
    if (!serverUrl) {
      throw setupError(
        "SETUP_NOT_LOGGED_IN",
        "A server URL is required when no login profile exists.",
      );
    }
    let storedCredential: Credential | null;
    try {
      storedCredential = await this.options.credentials.load(serverUrl);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError("SETUP_CREDENTIALS_FAILED", "Could not read the local login credential.");
    }
    let credential: Credential | null = storedCredential;
    if (!credential && this.options.authenticate) {
      try {
        credential = await this.options.authenticate.authenticate(serverUrl, input.json ?? false);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw setupError("SETUP_OAUTH_FAILED", "OAuth login could not be completed.");
      }
    }
    if (!credential)
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");
    if (!profile && this.options.config.saveCurrentProfile) {
      await this.options.config.saveCurrentProfile({ serverUrl });
    }

    if (!input.workspaceSlug) {
      throw setupError(
        "SETUP_WORKSPACE_REQUIRED",
        "Setup requires a Workspace setup intent; Computer does not select Workspaces.",
      );
    }
    let workspace: AccessibleWorkspace;
    try {
      workspace = await this.options.workspaceLookup.getBySlug(
        serverUrl,
        credential,
        input.workspaceSlug,
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "AUTH_WORKSPACE_GET_FAILED") {
        throw setupError(
          "SETUP_WORKSPACE_NOT_FOUND",
          `Workspace '${input.workspaceSlug}' was not found or is not accessible.`,
        );
      }
      if (error instanceof CliError) throw error;
      throw setupError(
        "SETUP_WORKSPACE_LOOKUP_FAILED",
        "Could not look up the requested Workspace.",
      );
    }

    let configPath: string;
    const previousRegistration = (await this.options.config.loadRegistration?.()) ?? null;
    let registeredRegistration:
      | Parameters<NonNullable<ComputerConfig["discardRegistration"]>>[0]
      | undefined;
    try {
      const metadata = await this.options.metadataProvider.get();
      let response: Awaited<ReturnType<ComputerRegistrationClient["register"]>>;
      try {
        response = await this.options.registrationFactory(serverUrl, credential).register({
          protocolMajor: 1,
          requestId: this.options.idempotencyKeyProvider.create(
            serverUrl,
            input.workspaceSlug ?? workspace.slug,
          ),
          workspaceSlug: workspace.slug,
          machineId: metadata.machineId,
          platform: metadata.platform,
          osVersion: metadata.osVersion,
          computerVersion: metadata.computerVersion,
          runtimes: metadata.runtimes,
          registrationIdempotencyKey: this.options.idempotencyKeyProvider.create(
            serverUrl,
            `${input.workspaceSlug ?? workspace.slug}:${metadata.machineId}`,
          ),
        });
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw setupError(
          "SETUP_COMPUTER_REGISTER_FAILED",
          "Computer registration could not be completed.",
        );
      }
      workspace = { id: response.workspaceId, slug: workspace.slug, name: workspace.name };
      registeredRegistration = {
        id: response.workspaceId,
        slug: workspace.slug,
        computerId: response.computerId,
      };
      // Start first: the Daemon must accept its credential before local
      // configuration advertises this registration as usable.
      const launcher =
        typeof this.options.launcher === "function"
          ? this.options.launcher(serverUrl)
          : this.options.launcher;
      // Replacement is deliberately ordered: stop the old daemon before the
      // new binding is advertised. The old local binding remains on disk until
      // the new one is durably saved, so failures are visible and recoverable.
      if (
        previousRegistration &&
        previousRegistration.id !== response.workspaceId &&
        "stopAll" in launcher &&
        typeof launcher.stopAll === "function"
      ) {
        await launcher.stopAll();
      }
      try {
        await launcher.ensureStarted({
          workspaceId: response.workspaceId,
          computerId: response.computerId,
          workspaceRoot: this.options.workspaceRoot,
          daemonToken: response.daemonToken,
        });
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw setupError("SETUP_DAEMON_START_FAILED", "The Daemon could not be started.");
      }
      try {
        configPath = await this.options.config.saveRegistration(registeredRegistration);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw setupError(
          "SETUP_CONFIG_WRITE_FAILED",
          "Could not save the Workspace configuration.",
        );
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError(
        "SETUP_COMPUTER_REGISTER_FAILED",
        "Computer registration could not be completed.",
        "computer-registration",
        error,
      );
    }

    return { workspace, configPath };
  }

  private async loadProfile(): Promise<{ serverUrl: string } | null> {
    try {
      return await this.options.config.loadCurrentProfile();
    } catch {
      return null;
    }
  }
}
