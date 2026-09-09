import { RedisClient } from "bun";
import { REMINDER_CAPABILITY } from "@coforge/protocol";
import type { ReminderCapabilityLease } from "./reminders.server";

const TTL_SECONDS = "90";
export class RedisReminderCapabilityLease implements ReminderCapabilityLease {
  constructor(
    private readonly redis: {
      set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
      get(key: string): Promise<string | null>;
    },
  ) {}
  record(workspaceId: string, computerId: string, capabilities: readonly string[]) {
    return this.redis.set(
      this.key(workspaceId, computerId),
      capabilities.includes(REMINDER_CAPABILITY) ? "supported" : "unsupported",
      "EX",
      TTL_SECONDS,
    );
  }
  async supports(workspaceId: string, computerId: string) {
    return (await this.redis.get(this.key(workspaceId, computerId))) === "supported";
  }
  async refresh(workspaceId: string, computerId: string) {
    const key = this.key(workspaceId, computerId);
    if ((await this.redis.get(key)) === "supported")
      await this.redis.set(key, "supported", "EX", TTL_SECONDS);
  }
  private key(workspaceId: string, computerId: string) {
    return `coforge:reminder-capability:v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(computerId)}`;
  }
}

let lease: RedisReminderCapabilityLease | undefined;
export function getReminderCapabilityLease() {
  lease ??= new RedisReminderCapabilityLease(
    new RedisClient(
      Bun.env.REDIS_URL ??
        (() => {
          throw new Error("REDIS_URL is required for reminder capability leases");
        })(),
    ),
  );
  return lease;
}
