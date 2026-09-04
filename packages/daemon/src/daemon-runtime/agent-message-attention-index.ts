import type { AgentMessageDelivery, AgentMessageDeliveryAck } from "@coforge/protocol";
import { getLogger } from "@logtape/logtape";
import type { AgentProcessManager } from "../agent-runtime/agent-process-manager";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type MessageAttention = Readonly<{
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestSender?: string;
  flags: readonly string[];
}>;

/** Daemon-owned volatile attention index. It deliberately never stores/forwards body text. */
export class AgentMessageAttentionIndex {
  readonly #seen = new Set<string>();
  readonly #notified = new Set<string>();
  readonly #notificationAttempts = new Map<string, Promise<void>>();
  readonly #attention = new Map<string, Map<string, MessageAttention>>();
  readonly #modelSeen = new Map<string, Map<string, number>>();
  readonly #workspaceId: string;
  readonly #runtimes: Pick<AgentProcessManager, "session">;

  constructor(
    workspaceId: string,
    runtimes: Pick<AgentProcessManager, "session">,
    private readonly sendAck: (ack: AgentMessageDeliveryAck) => Promise<void>,
  ) {
    this.#workspaceId = workspaceId;
    this.#runtimes = runtimes;
  }

  async receive(message: AgentMessageDelivery): Promise<void> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (
      !message.conversationId ||
      !message.agentId ||
      !message.messageId ||
      !message.body ||
      message.sequence < 1
    )
      throw new Error("invalid agent message scope");
    if (this.#seen.has(message.deliveryId)) {
      if (!this.#notified.has(message.deliveryId)) {
        const attempt = this.#notificationAttempts.get(message.deliveryId);
        await (attempt ?? this.#notify(message));
      }
      await this.sendAck({
        ...message,
        method: "agent:deliver:ack",
        requestId: message.requestId,
      });
      return;
    }
    this.#seen.add(message.deliveryId);
    const target = message.target ?? "@unknown";
    if (!target.startsWith("@") || target.length < 2)
      throw new Error("delivery target must be public @username");
    if (this.modelSeenSequence(message.agentId, target) >= message.sequence) {
      await this.sendAck({
        ...message,
        method: "agent:deliver:ack",
        requestId: message.requestId,
      });
      return;
    }
    const latestSender =
      message.latestSender?.startsWith("@") && message.latestSender.length > 1
        ? message.latestSender
        : undefined;
    const byTarget = this.#attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    const current = {
      target,
      pendingCount: (previous?.pendingCount ?? 0) + 1,
      firstPendingSequence: previous?.firstPendingSequence ?? message.sequence,
      latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
      ...(latestSender ? { latestSender } : {}),
      flags: ["dm"],
    };
    byTarget.set(target, current);
    this.#attention.set(message.agentId, byTarget);
    await this.#notify(message, current);
    await this.sendAck({ ...message, method: "agent:deliver:ack", requestId: message.requestId });
  }

  #notify(message: AgentMessageDelivery, attention?: MessageAttention): Promise<void> {
    const session = this.#runtimes.session(message.agentId);
    if (!session?.notify)
      return Promise.reject(new Error("Agent session cannot receive a wakeup notice"));
    const current =
      attention ?? this.#attention.get(message.agentId)?.get(message.target ?? "@unknown");
    const pendingCount = current?.pendingCount ?? 1;
    const totalPendingCount = [...(this.#attention.get(message.agentId)?.values() ?? [])].reduce(
      (total, item) => total + item.pendingCount,
      0,
    );
    const target = current?.target ?? message.target ?? "@unknown";
    const latestSender = current?.latestSender ? ` · latest sender ${current.latestSender}` : "";
    const notice = `[CoForge inbox notice:
Inbox update: ${totalPendingCount} unread message${totalPendingCount === 1 ? "" : "s"} total; 1 changed target
${target}  pending: ${pendingCount} message${pendingCount === 1 ? "" : "s"}${latestSender}
Run \`coforge message check\` to read pending messages.]`;
    const notification = Promise.resolve()
      .then(() => session.notify!(notice))
      .then(() => {
        this.#notified.add(message.deliveryId);
        logger.info("Agent accepted inbox notice", {
          event: "agent.inbox_notice.accepted",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: 1,
          pending_count: pendingCount,
          total_pending_count: totalPendingCount,
          outcome: "ok",
        });
      })
      .catch((error: unknown) => {
        logger.error("Agent rejected inbox notice", {
          event: "agent.inbox_notice.rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: 1,
          pending_count: pendingCount,
          total_pending_count: totalPendingCount,
          error_code: error instanceof Error ? error.name : "UnknownError",
          outcome: "failed",
        });
        throw error;
      })
      .finally(() => {
        this.#notificationAttempts.delete(message.deliveryId);
      });
    this.#notificationAttempts.set(message.deliveryId, notification);
    return notification;
  }

  check(agentId: string): MessageAttention[] {
    return [...(this.#attention.get(agentId)?.values() ?? [])];
  }

  modelSeenSequence(agentId: string, target: string): number {
    return this.#modelSeen.get(agentId)?.get(target) ?? 0;
  }

  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const byTarget = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, Math.max(byTarget.get(target) ?? 0, sequence));
    this.#modelSeen.set(agentId, byTarget);

    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || sequence < attention.firstPendingSequence) return;
    if (sequence >= attention.latestSequence) {
      this.clear(agentId, target);
      return;
    }
    this.#attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount: attention.latestSequence - sequence,
      firstPendingSequence: sequence + 1,
    });
  }

  clearAgent(agentId: string): void {
    this.#attention.delete(agentId);
    this.#modelSeen.delete(agentId);
  }

  clear(agentId: string, target: string): void {
    const byTarget = this.#attention.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#attention.delete(agentId);
  }

  clearThrough(agentId: string, target: string, sequence: number): void {
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || attention.latestSequence <= sequence) this.clear(agentId, target);
  }
}
