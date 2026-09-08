import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CliError, loginError, setupError } from "./errors";

export type CurrentProfile = { serverUrl: string };
export type WorkspaceSelection = { id: string; slug: string };
export type RegisteredWorkspaceConnection = WorkspaceSelection & {
  computerId: string;
};

export interface ComputerConfig {
  saveCurrentProfile(profile: CurrentProfile): Promise<void>;
  loadCurrentProfile(): Promise<CurrentProfile | null>;
  saveWorkspace(workspace: WorkspaceSelection): Promise<string>;
  saveRegistration?(registration: RegisteredWorkspaceConnection): Promise<string>;
  loadRegistration?(): Promise<RegisteredWorkspaceConnection | null>;
  discardRegistration(registration: RegisteredWorkspaceConnection): Promise<void>;
}

export type BuildProfileOperation = "login" | "setup" | "daemon";

export async function loadBuildProfile(
  config: Pick<ComputerConfig, "loadCurrentProfile">,
  serverUrl: string,
  operation: BuildProfileOperation,
): Promise<CurrentProfile | null> {
  let profile: CurrentProfile | null;
  try {
    profile = await config.loadCurrentProfile();
    if (!profile) return null;
    if (new URL(profile.serverUrl).origin === new URL(serverUrl).origin) return profile;
  } catch (error) {
    throw profileReadError(operation, error);
  }
  throw profileMismatchError(operation);
}

export class FileComputerConfig implements ComputerConfig {
  constructor(private readonly directory: string) {}

  async saveCurrentProfile(profile: CurrentProfile): Promise<void> {
    await writeJson(join(this.directory, "profile.json"), { server_url: profile.serverUrl });
  }

  async loadCurrentProfile(): Promise<CurrentProfile | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, "profile.json"), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const value = JSON.parse(raw) as { server_url?: unknown };
    if (typeof value.server_url !== "string" || value.server_url.length === 0) {
      throw new Error("current profile is invalid");
    }
    return { serverUrl: value.server_url };
  }

  async saveWorkspace(workspace: WorkspaceSelection): Promise<string> {
    const directoryName = Buffer.from(workspace.id, "utf8").toString("base64url");
    const configPath = join(this.directory, "workspaces", directoryName, "config.json");
    await writeJson(configPath, { workspace_id: workspace.id });
    return configPath;
  }

  async saveRegistration(registration: RegisteredWorkspaceConnection): Promise<string> {
    const configPath = join(this.directory, "workspace", "config.json");
    await writeJson(configPath, {
      workspace_id: registration.id,
      computer_id: registration.computerId,
    });
    return configPath;
  }

  async loadRegistration(): Promise<RegisteredWorkspaceConnection | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, "workspace", "config.json"), "utf8"),
      ) as Record<string, unknown>;
      if (typeof value.workspace_id !== "string" || typeof value.computer_id !== "string")
        return null;
      return { id: value.workspace_id, slug: value.workspace_id, computerId: value.computer_id };
    } catch {
      return null;
    }
  }

  async discardRegistration(registration: RegisteredWorkspaceConnection): Promise<void> {
    // Kept as a compatibility no-op. Switching never deletes prior local state.
    void registration;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function profileReadError(operation: BuildProfileOperation, cause: unknown): CliError {
  if (operation === "login")
    return loginError(
      "AUTH_PROFILE_READ_FAILED",
      "The existing Computer profile could not be read.",
    );
  if (operation === "setup")
    return setupError(
      "SETUP_CONFIG_READ_FAILED",
      "The existing Computer profile could not be read.",
      "config-write",
      cause,
    );
  return new CliError(
    "BUILD_ENVIRONMENT_PROFILE_INVALID",
    "The existing Computer profile could not be read.",
    "Repair the Computer profile without changing its environment, then retry.",
    { cause },
  );
}

function profileMismatchError(operation: BuildProfileOperation): CliError {
  if (operation === "login")
    return loginError(
      "AUTH_BUILD_ENVIRONMENT_MISMATCH",
      "The existing Computer profile belongs to a different CoForge environment.",
    );
  if (operation === "setup")
    return setupError(
      "SETUP_BUILD_ENVIRONMENT_MISMATCH",
      "The existing Computer profile belongs to a different CoForge environment.",
    );
  return new CliError(
    "BUILD_ENVIRONMENT_MISMATCH",
    "The existing Computer profile belongs to a different CoForge environment.",
    "Install the build matching the existing environment. Do not delete the profile to switch environments.",
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
