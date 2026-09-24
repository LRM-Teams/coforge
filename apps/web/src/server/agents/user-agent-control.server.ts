import type { PrismaClient } from "#src/generated/prisma/client";
import { AgentControl } from "./agent-control.server";
import { getAgentControlSignal } from "./agent-control-signal.server";
import { getAgentRuntimeLock } from "./agent-runtime-lock.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "#src/server/db/repositories/agent-session.repositories.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** The `AgentControl` a signed-in user's Start, Stop, Restart and Reset go through. */
export function userAgentControl(db: PrismaClient) {
  return new AgentControl(
    new PrismaAgentControlStore(db),
    createCentrifugoServerApi(),
    getAgentRuntimeLock(),
    undefined,
    createAgentSessions(db),
    getAgentControlSignal(),
    new PrismaDirectConversationRepository(db),
  );
}
