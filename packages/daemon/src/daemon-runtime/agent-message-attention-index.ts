import type { AgentMessageDelivery, AgentMessageDeliveryAck } from "@coforge/protocol";
import type { AgentProcessManager } from "../agent-runtime/agent-process-manager";

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
    const latestSender =
      message.latestSender?.startsWith("@") && message.latestSender.length > 1
        ? message.latestSender
        : undefined;
    const byTarget = this.#attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    byTarget.set(target, {
      target,
      pendingCount: (previous?.pendingCount ?? 0) + 1,
      firstPendingSequence: previous?.firstPendingSequence ?? message.sequence,
      latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
      ...(latestSender ? { latestSender } : {}),
      flags: ["dm"],
    });
    this.#attention.set(message.agentId, byTarget);
    await this.#notify(message);
    await this.sendAck({ ...message, method: "agent:deliver:ack", requestId: message.requestId });
  }

  #notify(message: AgentMessageDelivery): Promise<void> {
    const session = this.#runtimes.session(message.agentId);
    if (!session?.notify)
      return Promise.reject(new Error("Agent session cannot receive a wakeup notice"));
    const notification = Promise.resolve()
      .then(() => session.notify!("New message available. Run coforge message check."))
      .then(() => {
        this.#notified.add(message.deliveryId);
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

  clear(agentId: string, target: string): void {
    const byTarget = this.#attention.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#attention.delete(agentId);
  }
}
