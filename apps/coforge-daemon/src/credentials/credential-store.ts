import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Daemon-owned storage for the credential used by one cloud connection. */
export interface DaemonCredentialStore {
  save(workspaceId: string, computerId: string, apiKey: string): Promise<void>;
  load(workspaceId: string, computerId: string): Promise<string | null>;
  delete(workspaceId: string, computerId: string): Promise<void>;
}

/** Stores the Daemon API key in its private local state directory. */
export class FileDaemonCredentialStore implements DaemonCredentialStore {
  readonly #directory: string;

  constructor(
    directory = process.env.COFORGE_DAEMON_HOME ?? join(homedir(), ".coforge", "daemon"),
  ) {
    this.#directory = join(directory, "credentials");
  }

  async save(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    const path = this.#path(workspaceId, computerId);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async load(workspaceId: string, computerId: string): Promise<string | null> {
    try {
      const apiKey = (await readFile(this.#path(workspaceId, computerId), "utf8")).trim();
      return apiKey || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(workspaceId: string, computerId: string): Promise<void> {
    await rm(this.#path(workspaceId, computerId), { force: true });
  }

  #path(workspaceId: string, computerId: string): string {
    return join(
      this.#directory,
      `${encodeURIComponent(workspaceId)}-${encodeURIComponent(computerId)}.api-key`,
    );
  }
}

/** Process-local adapter until platform keychain adapters are implemented. */
export class InMemoryDaemonCredentialStore implements DaemonCredentialStore {
  readonly #tokens = new Map<string, string>();

  async save(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    this.#tokens.set(`${workspaceId}:${computerId}`, apiKey);
  }
  async load(workspaceId: string, computerId: string): Promise<string | null> {
    return this.#tokens.get(`${workspaceId}:${computerId}`) ?? null;
  }
  async delete(workspaceId: string, computerId: string): Promise<void> {
    this.#tokens.delete(`${workspaceId}:${computerId}`);
  }
}
