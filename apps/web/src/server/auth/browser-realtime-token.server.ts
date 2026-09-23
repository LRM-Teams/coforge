import { importJWK, SignJWT, type JWK } from "jose";

import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "@/features/agents/agent-status-realtime";
import {
  agentActivityChannel,
  agentActivityChannelForAgent,
} from "@/features/agents/agent-activity";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
} from "@/features/conversations/conversation-realtime";

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
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  // The connection token grants no channels of its own: every channel on the
  // shared Workspace connection is subscribed client-side with its own
  // narrower, server-issued subscription token (see the `issue*SubscriptionToken`
  // functions below).
  return browserRealtimeSigner(environment, {}, input.userId);
}

export async function issueAgentActivitySubscriptionToken(
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: agentActivityChannel(input.workspaceId) },
    input.userId,
  );
}

export async function issueAgentStatusSubscriptionToken(
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: agentStatusChannel(input.workspaceId) },
    input.userId,
  );
}

/**
 * A private Agent's per-Agent Activity channel. Callers must check `canSeeAgent` for
 * `input.agentId` before calling this — the token itself grants exactly this one channel, so a
 * viewer who cannot see the Agent must never be issued one.
 */
export async function issueAgentActivitySubscriptionTokenForAgent(
  input: { userId: string; workspaceId: string; agentId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: agentActivityChannelForAgent(input.workspaceId, input.agentId) },
    input.userId,
  );
}

/** The per-Agent status-channel sibling of `issueAgentActivitySubscriptionTokenForAgent`. */
export async function issueAgentStatusSubscriptionTokenForAgent(
  input: { userId: string; workspaceId: string; agentId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: agentStatusChannelForAgent(input.workspaceId, input.agentId) },
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

/** The Workspace-level conversation signal channel, for the Chat sidebar's unread badges. */
export async function issueWorkspaceConversationSubscriptionToken(
  input: { userId: string; workspaceId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: workspaceConversationChannel(input.workspaceId) },
    input.userId,
  );
}

/**
 * The caller's own direct-message signal channel. It is issued to the viewer themselves and
 * bound to their own user id, so it can only ever carry that user's direct-message signals.
 */
export async function issueUserConversationSubscriptionToken(
  input: { userId: string },
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  return browserRealtimeSigner(
    environment,
    { channel: userConversationChannel(input.userId) },
    input.userId,
  );
}
