import { importJWK, SignJWT, type JWK } from "jose";

import { agentStatusChannel } from "../../features/agents/agent-status-realtime";
import { agentActivityChannel } from "../../features/agents/agent-activity-realtime";
import { conversationRealtimeChannel } from "../../features/conversations/conversation-realtime";

async function browserRealtimeSigner(
  environment: Record<string, string | undefined>,
  claims: Record<string, unknown>,
  userId: string,
) {
  const raw = environment.COFORGE_WORKER_JWT_PRIVATE_JWK;
  const kid = environment.COFORGE_WORKER_JWT_KEY_ID;
  if (!raw || !kid) throw new Error("Browser realtime authentication is not configured");
  const key = await importJWK(JSON.parse(raw) as JWK, "EdDSA");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(environment.COFORGE_WORKER_JWT_ISSUER ?? "coforge")
    .setAudience(environment.COFORGE_WORKER_JWT_AUDIENCE ?? "coforge-centrifugo")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

export async function issueBrowserRealtimeToken(
  input: { userId: string; workspaceId: string; stream?: "activity" },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    {
      channels: [
        input.stream === "activity"
          ? agentActivityChannel(input.workspaceId)
          : agentStatusChannel(input.workspaceId),
      ],
    },
    input.userId,
  );
}

export function issueConversationRealtimeToken(
  input: { userId: string; conversationId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: conversationRealtimeChannel(input.conversationId) },
    input.userId,
  );
}
