import type { Credential, CredentialStore } from "./login";
import { loginError } from "./errors";

type Secrets = Pick<typeof Bun.secrets, "set"> & Partial<Pick<typeof Bun.secrets, "get">>;

export class NativeCredentialStore implements CredentialStore {
  constructor(private readonly secrets: Secrets = Bun.secrets) {}

  async save(serverUrl: string, credential: Credential): Promise<void> {
    try {
      await this.secrets.set({
        service: "cn.coforge.computer",
        name: serverUrl,
        value: JSON.stringify(credential),
      });
    } catch {
      throw loginError(
        "AUTH_CREDENTIAL_STORE_UNAVAILABLE",
        "The operating system credential store is unavailable.",
      );
    }
  }

  async load(serverUrl: string): Promise<Credential | null> {
    try {
      if (!this.secrets.get) throw new Error("credential reads are unavailable");
      const value = await this.secrets.get({ service: "cn.coforge.computer", name: serverUrl });
      if (value === null) return null;
      const credential = JSON.parse(value) as Partial<Credential>;
      if (
        typeof credential.accessToken !== "string" ||
        credential.accessToken.length === 0 ||
        typeof credential.tokenType !== "string" ||
        credential.tokenType.length === 0
      ) {
        throw new Error("stored credential is invalid");
      }
      return credential as Credential;
    } catch {
      throw loginError(
        "AUTH_CREDENTIAL_STORE_UNAVAILABLE",
        "The operating system credential store is unavailable.",
      );
    }
  }

  async saveDaemonCredential(
    workspaceId: string,
    computerId: string,
    credential: string,
  ): Promise<void> {
    try {
      await this.secrets.set({
        service: "cn.coforge.computer.daemon",
        name: `${workspaceId}:${computerId}`,
        value: credential,
      });
    } catch {
      throw loginError(
        "AUTH_CREDENTIAL_STORE_UNAVAILABLE",
        "The operating system credential store is unavailable.",
      );
    }
  }
}
