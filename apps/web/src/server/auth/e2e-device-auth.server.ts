import { importJWK, SignJWT, type JWK } from "jose";

const CLIENT_ID = "coforge-computer";
const issuer = (request: Request) => {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    url.protocol = `${forwardedProto.split(",")[0].trim()}:`;
    url.host = forwardedHost.split(",")[0].trim();
  }
  return url.origin;
};

function enabled(): boolean {
  return process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH === "1";
}

function unavailable(): Response {
  return new Response("E2E device authorization is disabled", { status: 404 });
}

const pending = new Map<string, { expires: number; polls: number }>();

/** The formal RFC 8414 discovery handler. E2E swaps the provider implementation,
 * but the public route and ComputerSetup flow remain unchanged. */
export function oauthDiscovery(request: Request): Response {
  if (!enabled()) return unavailable();
  const base = issuer(request);
  return Response.json(
    {
      issuer: base,
      device_authorization_endpoint: `${base}/oauth/device`,
      token_endpoint: `${base}/oauth/token`,
      coforge_workspaces_endpoint: `${base}/api/e2e/workspaces`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function e2eDevice(request: Request): Promise<Response> {
  if (!enabled()) return unavailable();
  const body = new URLSearchParams(await request.text());
  if (body.get("client_id") !== CLIENT_ID)
    return Response.json({ error: "invalid_client" }, { status: 400 });
  const code = `e2e-${crypto.randomUUID()}`;
  pending.set(code, { expires: Date.now() + 60_000, polls: 0 });
  return Response.json(
    {
      device_code: code,
      user_code: "E2E-APPROVE",
      verification_uri: `${issuer(request)}/oauth/verify`,
      expires_in: 60,
      interval: 0,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function e2eToken(request: Request): Promise<Response> {
  if (!enabled()) return unavailable();
  const body = new URLSearchParams(await request.text());
  const state = pending.get(body.get("device_code") ?? "");
  if (!state || state.expires < Date.now())
    return Response.json({ error: "expired_token" }, { status: 400 });
  state.polls++;
  if (state.polls < 2) return Response.json({ error: "authorization_pending" }, { status: 400 });
  const raw = process.env.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = process.env.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) return Response.json({ error: "server_error" }, { status: 500 });
  const key = await importJWK(JSON.parse(raw) as JWK, "EdDSA");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject("00000000-0000-5000-8000-000000000001")
    .setIssuer(process.env.COFORGE_WORKER_JWT_ISSUER ?? "coforge")
    .setAudience(process.env.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
  pending.delete(body.get("device_code") ?? "");
  return Response.json(
    { access_token: token, token_type: "Bearer", expires_in: 600 },
    { headers: { "cache-control": "no-store" } },
  );
}
