import { RedisClient } from "bun";
import type { PrismaClient } from "../../../generated/client";
import { PrismaCausalMemoryRepository } from "../db/repositories/causal-memory.repositories.server";
import { getDatabaseClient } from "../db/client.server";
import {
  CAUSAL_QUIET_WINDOW_MS,
  causalMemoryRuntimeUrl,
  tenantTokenForWorkspace,
} from "./config.server";
import { detectAdmittedSegments, type AdmissionMessage } from "./admission";
import { CausalMemory, createCausalRuntimeClient } from "./module";

export const CAUSAL_ADMISSION_SWEEP_INTERVAL_MS = 30_000;
const SWEEP_LOCK_TTL_MS = 25_000;
const SWEEP_LOCK_KEY = "coforge:causal-memory:admission-sweep:lock";

export interface CausalAdmissionSweepLock {
  acquire(instanceId: string): Promise<boolean>;
}

type LockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export class RedisCausalAdmissionSweepLock implements CausalAdmissionSweepLock {
  constructor(private readonly redis: LockRedisPort) {}

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.redis.set(SWEEP_LOCK_KEY, instanceId, "NX", "PX", SWEEP_LOCK_TTL_MS);
    return result === "OK";
  }
}

export class CausalAdmissionSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly lock: CausalAdmissionSweepLock,
    private readonly now: () => Date = () => new Date(),
    private readonly instanceId: string = crypto.randomUUID(),
    private readonly createMemory: (workspaceId: string, tenantId: string) => CausalMemory = (
      workspaceId,
      tenantId,
    ) =>
      new CausalMemory(
        new PrismaCausalMemoryRepository(this.db),
        createCausalRuntimeClient(causalMemoryRuntimeUrl()),
        async () => tenantTokenForWorkspace(workspaceId, tenantId),
        workspaceId,
      ),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CAUSAL_ADMISSION_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      const repository = new PrismaCausalMemoryRepository(this.db);
      for (const tenant of await repository.listEnabledTenants()) {
        try {
          await this.ingestWorkspace(repository, tenant.workspaceId, tenant.tenantId);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "causal_admission_sweep.workspace_failed",
              workspaceId: tenant.workspaceId,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "causal_admission_sweep.tick_failed",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async ingestWorkspace(
    repository: PrismaCausalMemoryRepository,
    workspaceId: string,
    tenantId: string,
  ): Promise<void> {
    const memory = this.createMemory(workspaceId, tenantId);
    const admittedMessageIds = await repository.listAdmittedMessageIds(workspaceId);
    const conversations = await this.db.conversation.findMany({
      where: { workspaceId, channelName: { not: null } },
      select: { id: true, workspaceId: true, channelName: true },
    });
    const messages = await this.loadMessages(
      workspaceId,
      conversations.map((row) => row.id),
    );
    const tasks = await this.db.task.findMany({
      where: {
        workspaceId,
        status: "done",
        conversationId: { in: conversations.map((row) => row.id) },
      },
      select: {
        messageId: true,
        conversationId: true,
        workspaceId: true,
        status: true,
        updatedAt: true,
      },
    });
    const detected = detectAdmittedSegments({
      conversations,
      messages,
      tasks,
      admittedMessageIds,
      now: this.now(),
      quietAfterMs: CAUSAL_QUIET_WINDOW_MS,
    });
    for (const segment of detected) {
      await memory.ingestAdmittedSegment({
        ...segment.ledger,
        session: segment.session,
        turns: segment.turns,
      });
    }
    for (const ledger of await repository.listRetryableLedgers(workspaceId)) {
      if (detected.some((segment) => segment.ledger.operationId === ledger.operationId)) continue;
      const retryMessages = await this.loadMessages(
        workspaceId,
        undefined,
        ledger.sourceMessageIds,
      );
      const channelId = retryMessages[0]?.conversationId;
      if (!channelId) continue;
      await memory.ingestAdmittedSegment({
        ...ledger,
        session: { workspaceId, channelId },
        turns: retryMessages.map((message) => ({
          messageId: message.id,
          sequence: message.sequence,
          occurredAt: message.createdAt.toISOString(),
          payloadHash: ledger.sourcePayloadHash,
          senderKind: message.senderKind,
          senderHandle: message.senderHandle,
          body: message.body,
        })),
      });
    }
  }

  private async loadMessages(
    workspaceId: string,
    conversationIds?: string[],
    messageIds?: string[],
  ): Promise<AdmissionMessage[]> {
    const rows = await this.db.message.findMany({
      where: {
        workspaceId,
        ...(conversationIds ? { conversationId: { in: conversationIds } } : {}),
        ...(messageIds ? { id: { in: messageIds } } : {}),
      },
      select: {
        id: true,
        conversationId: true,
        workspaceId: true,
        sequence: true,
        createdAt: true,
        body: true,
        sender: {
          select: {
            agentId: true,
            user: { select: { username: true } },
            agent: { select: { name: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      workspaceId: row.workspaceId,
      sequence: row.sequence,
      createdAt: row.createdAt,
      body: row.body,
      senderKind: row.sender?.agentId ? "agent" : row.sender ? "human" : "system",
      senderHandle: row.sender?.user?.username ?? row.sender?.agent?.name ?? "system",
    }));
  }
}

let singleton: CausalAdmissionSweep | undefined;

export function ensureCausalAdmissionSweep(): CausalAdmissionSweep | undefined {
  const redisUrl = process.env.REDIS_URL;
  const db = getDatabaseClient();
  if (!redisUrl || !db) return undefined;
  singleton ??= new CausalAdmissionSweep(
    db,
    new RedisCausalAdmissionSweepLock(new RedisClient(redisUrl)),
  );
  singleton.start();
  return singleton;
}
