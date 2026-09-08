import { RedisClient } from "bun";
import {
  decodeAgentSkillsListResult,
  encodeAgentSkillsListResult,
  type AgentSkillsListResult,
} from "@coforge/protocol";
import {
  sameSkillsScope,
  type AgentSkillsResults,
  type PendingSkills,
} from "../agents/agent-skills.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

// Compare the entire pending value atomically: expiry/cancellation cannot race
// the result write. First valid result wins; duplicates do not extend its TTL.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'EX', 30, 'NX') and 1 or 0`;

export class RedisAgentSkillsResults implements AgentSkillsResults {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}
  private keys(id: string) {
    return [`coforge:agent-skills:v1:${id}:pending`, `coforge:agent-skills:v1:${id}:result`];
  }
  async begin(pending: PendingSkills) {
    await this.redis.set(
      this.keys(pending.request.requestId)[0]!,
      JSON.stringify(pending),
      "EX",
      "30",
    );
  }
  async read(requestId: string) {
    const value = await this.redis.get(this.keys(requestId)[1]!);
    return value ? decodeAgentSkillsListResult(Buffer.from(value, "base64")) : undefined;
  }
  async clear(requestId: string) {
    await this.redis.send("DEL", this.keys(requestId));
  }
  async accept(result: AgentSkillsListResult) {
    const keys = this.keys(result.requestId);
    const value = await this.redis.get(keys[0]!);
    if (!value) return;
    const pending = JSON.parse(value) as PendingSkills;
    if (!sameSkillsScope(pending.request, result)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "2",
      ...keys,
      value,
      Buffer.from(encodeAgentSkillsListResult(result)).toString("base64"),
    ]);
  }
}

let singleton: RedisAgentSkillsResults | undefined;
export function getAgentSkillsResults() {
  if (!singleton) {
    const url = Bun.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is required for Skills queries");
    singleton = new RedisAgentSkillsResults(new RedisClient(url));
  }
  return singleton;
}

export function createAgentSkillsListResultMethod(
  results?: Pick<RedisAgentSkillsResults, "accept">,
): CentrifugoRpcMethod {
  return async (payload, { principal }) => {
    const result = decodeAgentSkillsListResult(payload);
    if (
      !principal.userId ||
      principal.agentId ||
      principal.workspaceId !== result.workspaceId ||
      principal.computerId !== result.computerId
    )
      return { code: 403, message: "Skills result scope is not authorized" };
    await (results ?? getAgentSkillsResults()).accept(result);
    return new Uint8Array();
  };
}
