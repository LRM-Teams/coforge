import { RedisClient } from "bun";

const HOLD_TTL_SECONDS = 15 * 60;
const CONSUME_MATCHING = `
local value = redis.call("GET", KEYS[1])
if not value or value ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])`;

export type AgentMessageHold = {
  agentId: string;
  workspaceId: string;
  target: string;
  bodyHash: string;
  presentedThrough: number;
  stage: 1 | 2;
  expiresAt: string;
};

export interface AgentMessageHoldStore {
  issue(hold: AgentMessageHold): Promise<string>;
  get(token: string): Promise<AgentMessageHold | undefined>;
  consume(token: string, hold: AgentMessageHold): Promise<boolean>;
}

interface RedisHoldCommands {
  set(key: string, value: string, ex: "EX", seconds: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  send(command: "EVAL", args: string[]): Promise<number>;
}

export class RedisAgentMessageHoldStore implements AgentMessageHoldStore {
  constructor(private readonly redis: RedisHoldCommands) {}

  async issue(hold: AgentMessageHold) {
    const token = `amh_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    await this.redis.set(this.key(token), JSON.stringify(hold), "EX", String(HOLD_TTL_SECONDS));
    return token;
  }

  async get(token: string) {
    const value = await this.redis.get(this.key(token));
    if (!value) return undefined;
    const hold = JSON.parse(value) as AgentMessageHold;
    return Date.parse(hold.expiresAt) > Date.now() ? hold : undefined;
  }

  async consume(token: string, hold: AgentMessageHold) {
    return (
      (await this.redis.send("EVAL", [
        CONSUME_MATCHING,
        "1",
        this.key(token),
        JSON.stringify(hold),
      ])) === 1
    );
  }

  private key(token: string) {
    return `coforge:agent-message-hold:v1:${encodeURIComponent(token)}`;
  }
}

export async function hashAgentDraft(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Buffer.from(digest).toString("hex");
}

let singleton: RedisAgentMessageHoldStore | undefined;
export function getAgentMessageHoldStore() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for Agent message holds");
  singleton ??= new RedisAgentMessageHoldStore(new RedisClient(redisUrl));
  return singleton;
}
