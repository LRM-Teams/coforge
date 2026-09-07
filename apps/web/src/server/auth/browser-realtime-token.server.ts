import { importJWK, SignJWT, type JWK } from "jose";

export async function issueBrowserRealtimeToken(
  input: { userId: string; workspaceId: string; stream?: "status" | "activity" },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  const raw = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) throw new Error("Browser realtime authentication is not configured");
  const key = await importJWK(JSON.parse(raw) as JWK, "EdDSA");
  return new SignJWT({ channels: [`${input.stream ?? "status"}:${input.workspaceId}`] })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(environment.COFORGE_WORKER_JWT_ISSUER ?? "coforge")
    .setAudience(environment.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
