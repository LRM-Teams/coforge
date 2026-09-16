import { RedisClient } from "bun";

/**
 * Wakes a control waiter when an Agent's control state changes, so `drive()`
 * does not have to poll PostgreSQL every 100ms. Waiters still fall back to a
 * slow re-read, so a lost signal only delays completion.
 */
export interface AgentControlSignal {
  notify(agentId: string): Promise<void>;
  /** Resolves `true` when `notify(agentId)` fires, `false` when `timeoutMs` elapses first. */
  wait(agentId: string, timeoutMs: number): Promise<boolean>;
}

/** Same-process waiters; the Redis implementation fans out to these. */
export class LocalAgentControlSignal implements AgentControlSignal {
  private readonly waiters = new Map<string, Set<(signaled: boolean) => void>>();

  async notify(agentId: string) {
    this.wake(agentId);
  }

  wake(agentId: string) {
    const pending = this.waiters.get(agentId);
    if (!pending) return;
    this.waiters.delete(agentId);
    for (const resolve of pending) resolve(true);
  }

  wait(agentId: string, timeoutMs: number) {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let pending = this.waiters.get(agentId);
      if (!pending) this.waiters.set(agentId, (pending = new Set()));
      const done = (signaled: boolean) => {
        clearTimeout(timer);
        pending!.delete(done);
        if (pending!.size === 0 && this.waiters.get(agentId) === pending)
          this.waiters.delete(agentId);
        resolve(signaled);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      pending.add(done);
    });
  }
}

const CHANNEL = "coforge:agent-control:v1";

/** Cross-instance wake-ups: the RPC ACK may land on a different web instance than the waiter. */
export class RedisAgentControlSignal implements AgentControlSignal {
  private readonly local = new LocalAgentControlSignal();
  private subscription: Promise<void> | undefined;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: () => RedisClient,
  ) {}

  async notify(agentId: string) {
    this.local.wake(agentId);
    // Never block the ACK path on Redis; waiters elsewhere fall back to their slow re-read.
    this.publisher.publish(CHANNEL, agentId).catch(() => {});
  }

  wait(agentId: string, timeoutMs: number) {
    if (timeoutMs <= 0) return Promise.resolve(false);
    this.subscribe();
    // The fallback timeout bounds the wait even while the subscription is still connecting.
    return this.local.wait(agentId, timeoutMs);
  }

  private subscribe() {
    this.subscription ??= this.subscriber()
      .subscribe(CHANNEL, (message) => this.local.wake(message))
      .then(
        () => {},
        () => {
          this.subscription = undefined;
        },
      );
  }
}

let singleton: AgentControlSignal | undefined;

export function getAgentControlSignal(): AgentControlSignal {
  if (singleton) return singleton;
  const redisUrl = process.env.REDIS_URL;
  return (singleton = redisUrl
    ? new RedisAgentControlSignal(new RedisClient(redisUrl), () => new RedisClient(redisUrl))
    : new LocalAgentControlSignal());
}
