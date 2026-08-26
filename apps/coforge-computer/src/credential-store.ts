import type { Credential, CredentialStore } from "./login";
import { loginError } from "./errors";

type Secrets = Pick<typeof Bun.secrets, "set">;

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
}
