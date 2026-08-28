/** Daemon-owned storage for the credential used by one cloud connection. */
export interface WorkspaceWorkerCredentialStore {
  save(connectionId: string, token: string): Promise<void>;
  load(connectionId: string): Promise<string | null>;
  delete(connectionId: string): Promise<void>;
}

type Secrets = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

const CREDENTIAL_SERVICE = "cn.coforge.daemon.workspace-worker";

/** Stores Workspace Worker tokens in the operating system credential store. */
export class NativeWorkspaceWorkerCredentialStore implements WorkspaceWorkerCredentialStore {
  constructor(private readonly secrets: Secrets = Bun.secrets) {}

  async save(connectionId: string, token: string): Promise<void> {
    await this.secrets.set({
      service: CREDENTIAL_SERVICE,
      name: connectionId,
      value: token,
    });
  }

  async load(connectionId: string): Promise<string | null> {
    return await this.secrets.get({
      service: CREDENTIAL_SERVICE,
      name: connectionId,
    });
  }

  async delete(connectionId: string): Promise<void> {
    await this.secrets.delete({
      service: CREDENTIAL_SERVICE,
      name: connectionId,
    });
  }
}

/** Process-local adapter until platform keychain adapters are implemented. */
export class InMemoryWorkspaceWorkerCredentialStore implements WorkspaceWorkerCredentialStore {
  readonly #tokens = new Map<string, string>();

  async save(connectionId: string, token: string): Promise<void> {
    this.#tokens.set(connectionId, token);
  }
  async load(connectionId: string): Promise<string | null> {
    return this.#tokens.get(connectionId) ?? null;
  }
  async delete(connectionId: string): Promise<void> {
    this.#tokens.delete(connectionId);
  }
}
