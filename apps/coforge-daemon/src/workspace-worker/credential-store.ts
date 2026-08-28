/** Daemon-owned storage for the credential used by one cloud connection. */
export interface WorkspaceWorkerCredentialStore {
  save(workspaceId: string, computerId: string, token: string): Promise<void>;
  load(workspaceId: string, computerId: string): Promise<string | null>;
  delete(workspaceId: string, computerId: string): Promise<void>;
}

type Secrets = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

const CREDENTIAL_SERVICE = "cn.coforge.daemon.workspace-worker";

/** Stores Workspace Worker tokens in the operating system credential store. */
export class NativeWorkspaceWorkerCredentialStore implements WorkspaceWorkerCredentialStore {
  constructor(private readonly secrets: Secrets = Bun.secrets) {}

  async save(workspaceId: string, computerId: string, token: string): Promise<void> {
    await this.secrets.set({
      service: CREDENTIAL_SERVICE,
      name: `${workspaceId}:${computerId}`,
      value: token,
    });
  }

  async load(workspaceId: string, computerId: string): Promise<string | null> {
    return await this.secrets.get({
      service: CREDENTIAL_SERVICE,
      name: `${workspaceId}:${computerId}`,
    });
  }

  async delete(workspaceId: string, computerId: string): Promise<void> {
    await this.secrets.delete({
      service: CREDENTIAL_SERVICE,
      name: `${workspaceId}:${computerId}`,
    });
  }
}

/** Process-local adapter until platform keychain adapters are implemented. */
export class InMemoryWorkspaceWorkerCredentialStore implements WorkspaceWorkerCredentialStore {
  readonly #tokens = new Map<string, string>();

  async save(workspaceId: string, computerId: string, token: string): Promise<void> {
    this.#tokens.set(`${workspaceId}:${computerId}`, token);
  }
  async load(workspaceId: string, computerId: string): Promise<string | null> {
    return this.#tokens.get(`${workspaceId}:${computerId}`) ?? null;
  }
  async delete(workspaceId: string, computerId: string): Promise<void> {
    this.#tokens.delete(`${workspaceId}:${computerId}`);
  }
}
