import { Pool, type PoolClient } from "pg";

export interface AgentRuntimeLock {
  run<T>(agentId: string, callback: () => Promise<T>): Promise<T>;
}

export class PostgresAgentRuntimeLock implements AgentRuntimeLock {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async run<T>(agentId: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [agentId]);
      locked = true;
      return await callback();
    } finally {
      await releaseLock(client, agentId, locked);
    }
  }
}

let defaultLock: AgentRuntimeLock | undefined;

export function getAgentRuntimeLock(): AgentRuntimeLock {
  if (defaultLock) return defaultLock;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Agent runtime lock persistence is unavailable");
  return (defaultLock = new PostgresAgentRuntimeLock(new Pool({ connectionString: databaseUrl })));
}

async function releaseLock(client: PoolClient, agentId: string, locked: boolean): Promise<void> {
  let destroy = false;
  try {
    if (!locked) return;
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
      [agentId],
    );
    if (!result.rows[0]?.unlocked) throw new Error("Agent runtime lock was not held");
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(destroy);
  }
}
