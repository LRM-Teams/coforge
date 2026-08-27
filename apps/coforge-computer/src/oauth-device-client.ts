import type {
  AccessibleWorkspace,
  Credential,
  DeviceAuthorization,
  DeviceAuthorizationClient,
  TokenPollResult,
} from "./login";
import { CliError, loginError } from "./errors";

type OAuthMetadata = {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  coforge_workspaces_endpoint?: string;
};

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OAuthDeviceClient implements DeviceAuthorizationClient {
  readonly #fetch: Fetch;
  readonly #clientId: string;
  readonly #scope: string;
  #tokenEndpoint: string | null = null;
  #workspacesEndpoint: string | null = null;

  constructor(input: { clientId: string; scope: string; fetch?: Fetch }) {
    this.#clientId = input.clientId;
    this.#scope = input.scope;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async authorize(serverUrl: string): Promise<DeviceAuthorization> {
    const issuer = normalizeServerUrl(serverUrl);
    const metadata = await this.#discover(issuer);
    const deviceAuthorizationEndpoint = normalizeEndpoint(
      metadata.device_authorization_endpoint,
      "device authorization endpoint",
    );
    this.#tokenEndpoint = normalizeEndpoint(metadata.token_endpoint, "token endpoint");
    this.#workspacesEndpoint =
      metadata.coforge_workspaces_endpoint === undefined
        ? null
        : normalizeEndpoint(metadata.coforge_workspaces_endpoint, "CoForge workspaces endpoint");

    const response = await this.#request(deviceAuthorizationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.#clientId, scope: this.#scope }),
    });
    const body = await readJson<Record<string, unknown>>(response, "device authorization");
    const verificationUri = normalizeEndpoint(
      optionalString(body, "verification_uri_complete") ?? requiredString(body, "verification_uri"),
      "verification URI",
    );
    return {
      deviceCode: requiredString(body, "device_code"),
      userCode: requiredString(body, "user_code"),
      verificationUri,
      expiresInSeconds: requiredPositiveNumber(body, "expires_in"),
      intervalSeconds: optionalPositiveNumber(body, "interval") ?? 5,
    };
  }

  async pollToken(deviceCode: string, timeoutMilliseconds = 10_000): Promise<TokenPollResult> {
    if (!this.#tokenEndpoint) throw new Error("device authorization has not started");
    const response = await this.#pollRequest(this.#tokenEndpoint, timeoutMilliseconds, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.#clientId,
      }),
    });
    if (response === null) return { status: "network_timeout" };
    const body = await readJson<Record<string, unknown>>(response, "token polling", true);
    if (!response.ok) {
      if (body.error === "authorization_pending") return { status: "pending" };
      if (body.error === "slow_down") return { status: "slow_down" };
      if (body.error === "access_denied") {
        throw loginError("AUTH_DEVICE_CODE_CANCELLED", "Device authorization was cancelled.");
      }
      if (body.error === "expired_token") {
        throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
      }
      throw new Error(`device authorization failed: ${requiredString(body, "error")}`);
    }
    const credential: Credential = {
      accessToken: requiredString(body, "access_token"),
      tokenType: requiredString(body, "token_type"),
    };
    const refreshToken = optionalString(body, "refresh_token");
    const expiresInSeconds = optionalPositiveNumber(body, "expires_in");
    if (refreshToken) credential.refreshToken = refreshToken;
    if (expiresInSeconds) credential.expiresInSeconds = expiresInSeconds;
    return { status: "authorized", credential };
  }

  async listWorkspaces(credential: Credential): Promise<AccessibleWorkspace[]> {
    if (!this.#workspacesEndpoint) {
      throw loginError(
        "AUTH_WORKSPACE_LIST_FAILED",
        "OAuth metadata does not advertise the CoForge workspaces endpoint.",
      );
    }
    return await this.#requestWorkspaces(this.#workspacesEndpoint, credential);
  }

  async listWorkspacesForServer(
    serverUrl: string,
    credential: Credential,
  ): Promise<AccessibleWorkspace[]> {
    const issuer = normalizeServerUrl(serverUrl);
    const metadata = await this.#discover(issuer);
    if (metadata.coforge_workspaces_endpoint === undefined) {
      throw loginError(
        "AUTH_WORKSPACE_LIST_FAILED",
        "OAuth metadata does not advertise the CoForge workspaces endpoint.",
      );
    }
    const endpoint = normalizeEndpoint(
      metadata.coforge_workspaces_endpoint,
      "CoForge workspaces endpoint",
    );
    return await this.#requestWorkspaces(endpoint, credential);
  }

  async getWorkspaceForServer(
    serverUrl: string,
    credential: Credential,
    workspaceSlug: string,
  ): Promise<AccessibleWorkspace> {
    const issuer = normalizeServerUrl(serverUrl);
    const metadata = await this.#discover(issuer);
    if (metadata.coforge_workspaces_endpoint === undefined) {
      throw loginError(
        "AUTH_WORKSPACE_GET_FAILED",
        "OAuth metadata does not advertise the CoForge Workspace endpoint.",
      );
    }
    const endpoint = normalizeEndpoint(
      metadata.coforge_workspaces_endpoint,
      "CoForge workspaces endpoint",
    );
    const workspaceEndpoint = new URL(
      `${encodeURIComponent(workspaceSlug)}/`,
      endpoint.endsWith("/") ? endpoint : `${endpoint}/`,
    ).toString();
    const response = await this.#request(workspaceEndpoint, {
      headers: { authorization: `${credential.tokenType} ${credential.accessToken}` },
    });
    if (!response.ok) {
      throw loginError(
        "AUTH_WORKSPACE_GET_FAILED",
        `Could not access Workspace '${workspaceSlug}' (HTTP ${response.status}).`,
      );
    }
    try {
      const body = (await response.json()) as { workspace?: unknown };
      return readWorkspace(body.workspace ?? body);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw loginError("AUTH_WORKSPACE_GET_FAILED", "The Workspace response is invalid.");
    }
  }

  async #discover(issuer: string): Promise<OAuthMetadata> {
    const discoveryResponse = await this.#request(discoveryUrl(issuer));
    const metadata = await readJson<OAuthMetadata>(discoveryResponse, "OAuth discovery");
    if (metadata.issuer !== issuer) throw new Error("OAuth discovery issuer mismatch");
    return metadata;
  }

  async #requestWorkspaces(
    endpoint: string,
    credential: Credential,
  ): Promise<AccessibleWorkspace[]> {
    const response = await this.#request(endpoint, {
      headers: { authorization: `${credential.tokenType} ${credential.accessToken}` },
    });
    if (!response.ok) {
      throw loginError(
        "AUTH_WORKSPACE_LIST_FAILED",
        `Could not list accessible Workspaces (HTTP ${response.status}).`,
      );
    }
    try {
      const body = (await response.json()) as { workspaces?: unknown };
      if (!Array.isArray(body.workspaces)) throw new Error("workspaces is missing");
      return body.workspaces.map(readWorkspace);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw loginError("AUTH_WORKSPACE_LIST_FAILED", "The Workspace list response is invalid.");
    }
  }

  async #request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(input, init);
    } catch {
      throw loginError("AUTH_NETWORK_ERROR", "Could not reach the CoForge server.");
    }
  }

  async #pollRequest(
    input: RequestInfo | URL,
    timeoutMilliseconds: number,
    init: RequestInit,
  ): Promise<Response | null> {
    try {
      return await this.#fetch(input, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, timeoutMilliseconds)),
      });
    } catch (error) {
      if (isRequestTimeout(error)) return null;
      throw loginError("AUTH_NETWORK_ERROR", "Could not reach the CoForge server.");
    }
  }
}

function readWorkspace(value: unknown): AccessibleWorkspace {
  if (typeof value !== "object" || value === null) {
    throw loginError("AUTH_WORKSPACE_LIST_FAILED", "The Workspace list response is invalid.");
  }
  const body = value as Record<string, unknown>;
  return {
    id: requiredString(body, "id"),
    slug: requiredString(body, "slug"),
    name: requiredString(body, "name"),
  };
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidServer("server URL is invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw invalidServer("server URL must use HTTPS");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw invalidServer("server URL must not contain credentials, query, or fragment");
  }
  return url.href.replace(/\/$/, "");
}

function discoveryUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return url.href;
}

function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function invalidServer(message: string): CliError {
  return new CliError(
    "AUTH_INVALID_SERVER",
    message,
    "Use an HTTPS server URL without credentials, query parameters, or a fragment.",
  );
}

function normalizeEndpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is missing`);
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  return url.href;
}

async function readJson<T>(response: Response, name: string, allowError = false): Promise<T> {
  const body = (await response.json()) as T;
  if (!allowError && !response.ok) throw new Error(`${name} failed with HTTP ${response.status}`);
  return body;
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing`);
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredPositiveNumber(body: Record<string, unknown>, name: string): number {
  const value = optionalPositiveNumber(body, name);
  if (value === undefined) throw new Error(`${name} is missing`);
  return value;
}

function optionalPositiveNumber(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
