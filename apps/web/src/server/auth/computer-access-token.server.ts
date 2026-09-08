import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";

/**
 * The credential a Computer holds between `coforge-computer login` and `coforge-computer setup`.
 *
 * It is a Centrifugo connection token, not a bearer of our own invention: `setup` reaches the
 * cloud over the realtime transport (packages/computer/src/cloud-rpc-transport.ts passes
 * `credential.accessToken` straight to Centrifuge), and every RPC handler authorizes against
 * `metadata.principal.userId`, which is this token's subject. Signing it with the same key and
 * audience as the browser's realtime token is therefore the contract, not a shortcut - a token
 * of any other shape would simply be rejected at connect time.
 *
 * Its blast radius is one registration: `setup` exchanges it for a Daemon API key
 * (see daemon-api-key.server.ts), and that key - not this token - is what the Computer keeps.
 */
const AUDIENCE_DEFAULT = "coforge-centrifugo";
const ISSUER_DEFAULT = "coforge";

/**
 * Long enough that a user who starts `login`, walks away, and comes back to run `setup` is not
 * met with an authentication failure, short enough that a leaked token is not a standing grant.
 * The Computer stores an absolute expiry alongside the token so it can re-authenticate rather
 * than present an expired one.
 */
export const COMPUTER_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

function signingMaterial(environment: Record<string, string | undefined>) {
  const raw = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) throw new Error("Computer access token signing is not configured");
  return {
    jwk: JSON.parse(raw) as JWK,
    kid,
    issuer: environment.COFORGE_WORKER_JWT_ISSUER ?? ISSUER_DEFAULT,
    audience: environment.COFORGE_WORKER_JWT_AUDIENCE ?? AUDIENCE_DEFAULT,
  };
}

/** Mints the access token for one approved device authorization, bound to the approving user. */
export async function signComputerAccessToken(
  userId: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ token: string; expiresInSeconds: number }> {
  const { jwk, kid, issuer, audience } = signingMaterial(environment);
  const key = await importJWK(jwk, "EdDSA");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${COMPUTER_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
  return { token, expiresInSeconds: COMPUTER_ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verifies a token this service signed and returns its subject.
 *
 * Centrifugo checks this token itself on the realtime path, but the Workspace lookup is a plain
 * HTTP endpoint that has to do its own checking - and it must never trust a `sub` it has not
 * verified. The public half is derived from the private JWK the same way /api/jwks does it.
 */
export async function verifyComputerAccessToken(
  token: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ userId: string } | null> {
  let material: ReturnType<typeof signingMaterial>;
  try {
    material = signingMaterial(environment);
  } catch {
    return null;
  }
  const { d: _privateKey, key_ops: _keyOps, ...publicJwk } = material.jwk;
  try {
    const key = await importJWK({ ...publicJwk, alg: "EdDSA" }, "EdDSA");
    const { payload } = await jwtVerify(token, key, {
      issuer: material.issuer,
      audience: material.audience,
    });
    return typeof payload.sub === "string" && payload.sub ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}

/** Reads a `Bearer` token from a request and resolves the user it was issued to. */
export async function principalFromAuthorizationHeader(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ userId: string } | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verifyComputerAccessToken(header.slice("Bearer ".length).trim(), environment);
}
