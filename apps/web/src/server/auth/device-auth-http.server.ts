import { getDatabaseClient } from "../db/client.server";
import { PrismaDeviceAuthorizationStore } from "../db/repositories/device-auth.repositories.server";
import { publicOrigin } from "../http/public-origin.server";
import {
  authorizeDevice,
  DEVICE_CLIENT_ID,
  pollDeviceToken,
  type DeviceAuthorizationStore,
} from "./device-auth.server";
import { e2eDevice, e2eToken, oauthDiscovery as e2eDiscovery } from "./e2e-device-auth.server";

/**
 * The end-to-end harness (scripts/e2e/managed-web.sh) sets this to drive an unattended install
 * against a fixed code, which no real device flow can offer. It selects the test double rather
 * than gating the feature: before this existed the flag was the only way to have a device
 * endpoint at all, which is why staging - where it is correctly unset - answered `login` with a
 * 404. Release builds inline it as "0" (scripts/release/build-package.ts).
 */
function useE2EDouble(environment: Record<string, string | undefined>): boolean {
  return environment.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1";
}

const NO_STORE = { "cache-control": "no-store" } as const;

function unavailable(): Response {
  return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: NO_STORE });
}

function store(): DeviceAuthorizationStore | undefined {
  const db = getDatabaseClient();
  return db ? new PrismaDeviceAuthorizationStore(db) : undefined;
}

/** RFC 8414 discovery. `coforge_workspaces_endpoint` is a CoForge extension the Computer reads to
 * resolve a Workspace slug before registering; see packages/computer/src/oauth-device-client.ts. */
export function oauthDiscovery(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Response {
  if (useE2EDouble(environment)) return e2eDiscovery(request);
  const base = publicOrigin(request);
  return Response.json(
    {
      issuer: base,
      device_authorization_endpoint: `${base}/oauth/device`,
      token_endpoint: `${base}/oauth/token`,
      coforge_workspaces_endpoint: `${base}/api/workspaces`,
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
    },
    { headers: NO_STORE },
  );
}

export async function deviceAuthorizationRequest(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Promise<Response> {
  if (useE2EDouble(environment)) return e2eDevice(request);
  const body = new URLSearchParams(await request.text());
  if (body.get("client_id") !== DEVICE_CLIENT_ID)
    return Response.json({ error: "invalid_client" }, { status: 400, headers: NO_STORE });
  const deviceStore = store();
  if (!deviceStore) return unavailable();
  const result = await authorizeDevice({ store: deviceStore, origin: publicOrigin(request) });
  return Response.json(
    {
      device_code: result.deviceCode,
      user_code: result.userCode,
      verification_uri: result.verificationUri,
      verification_uri_complete: result.verificationUriComplete,
      expires_in: result.expiresInSeconds,
      interval: result.intervalSeconds,
    },
    { headers: NO_STORE },
  );
}

export async function deviceTokenRequest(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Promise<Response> {
  if (useE2EDouble(environment)) return e2eToken(request);
  const body = new URLSearchParams(await request.text());
  if (body.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code")
    return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: NO_STORE });
  if (body.get("client_id") !== DEVICE_CLIENT_ID)
    return Response.json({ error: "invalid_client" }, { status: 400, headers: NO_STORE });
  const deviceCode = body.get("device_code");
  if (!deviceCode)
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  const deviceStore = store();
  if (!deviceStore) return unavailable();

  const outcome = await pollDeviceToken({ store: deviceStore, deviceCode, environment });
  if (outcome.status === "error")
    return Response.json({ error: outcome.error }, { status: 400, headers: NO_STORE });
  return Response.json(
    {
      access_token: outcome.accessToken,
      token_type: "Bearer",
      expires_in: outcome.expiresInSeconds,
    },
    { headers: NO_STORE },
  );
}
