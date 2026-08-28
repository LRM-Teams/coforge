import type { AccessibleWorkspace, Credential } from "../login";
import type { ComputerConfig } from "../local-config";
import { CliError, setupError } from "../errors";
import type { ComputerRegisterRequest, ComputerRegistrationClient } from "@coforge/protocol";
import type { DaemonLauncher } from "@coforge/daemon";
import type { WorkspaceCatalog } from "../workspace/catalog";

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
  saveDaemonCredential(workspaceId: string, computerId: string, credential: string): Promise<void>;
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
    Required<Pick<ComputerConfig, "saveRegistration" | "discardRegistration">>;
  credentials: SetupCredentialStore;
  authenticate?: SetupAuthenticator;
  catalog: WorkspaceCatalog;
  registrationFactory: (serverUrl: string, credential: Credential) => SetupRegistration;
  launcher: DaemonLauncher | ((serverUrl: string) => DaemonLauncher);
  metadataProvider: ComputerMetadataProvider;
  idempotencyKeyProvider: RegistrationIdempotencyKeyProvider;
  selectWorkspace: (workspaces: AccessibleWorkspace[]) => Promise<AccessibleWorkspace>;
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
    const credential =
      (await this.options.credentials.load(serverUrl)) ??
      (this.options.authenticate
        ? await this.options.authenticate.authenticate(serverUrl, input.json ?? false)
        : null);
    if (!credential)
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");
    if (!profile && this.options.config.saveCurrentProfile) {
      await this.options.config.saveCurrentProfile({ serverUrl });
    }

    let workspace: AccessibleWorkspace;
    if (input.workspaceSlug) {
      try {
        workspace = await this.options.catalog.getBySlug(
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
        throw error;
      }
    } else {
      if (input.json || !this.options.selectWorkspace) {
        throw setupError("SETUP_WORKSPACE_REQUIRED", "A Workspace is required for this setup.");
      }
      const workspaces = await this.options.catalog.listAccessible(serverUrl, credential);
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
      const metadata = await this.options.metadataProvider.get();
      const response = await this.options.registrationFactory(serverUrl, credential).register({
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
      await launcher.ensureStarted({
        workspaceId: response.workspaceId,
        computerId: response.computerId,
        workspaceRoot: this.options.workspaceRoot,
        workspaceWorkerToken: response.workspaceWorkerToken,
      });
      configPath = await this.options.config.saveRegistration(
        registeredRegistration,
        response.workspaceWorkerToken,
      );
      await this.options.credentials.saveDaemonCredential(
        response.workspaceId,
        response.computerId,
        response.workspaceWorkerToken,
      );
    } catch (error) {
      if (registeredRegistration) {
        try {
          await this.options.config.discardRegistration(registeredRegistration);
        } catch {
          // Preserve the setup failure; cleanup is best effort.
        }
      }
      if (error instanceof CliError) throw error;
      throw setupError("SETUP_CONFIG_WRITE_FAILED", "Could not save the Workspace configuration.");
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
