import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/client";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "../src/server/centrifugo/server-api.server";
import { getUsageCache } from "../src/server/centrifugo/usage-cache.server";

const workspaceSlug = required("COFORGE_E2E_WORKSPACE_SLUG");
const databaseUrl = required("DATABASE_URL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

try {
  const connection = await waitForConnection();
  const provider = connection.computer.runtimes.some(({ provider }) => provider === "codex")
    ? "codex"
    : connection.computer.runtimes.some(({ provider }) => provider === "claude-code")
      ? "claude-code"
      : undefined;
  if (!provider) throw new Error("no supported provider runtime was discovered");

  const scanId = await createUsageScan(createCentrifugoServerApi(), {
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    provider,
  });
  const result = await waitForUsage(
    connection.workspaceId,
    connection.computerId,
    provider,
    scanId,
  );
  if (result.status !== "available" || !result.snapshot)
    throw new Error(`provider usage scan failed with status ${result.status}`);
  console.log(`provider usage verified: provider=${provider}`);
} finally {
  await db.$disconnect();
}

async function waitForConnection() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const workspace = await db.workspace.findUnique({
      where: { slug: workspaceSlug },
      select: {
        computers: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            workspaceId: true,
            computerId: true,
            computer: { select: { runtimes: { select: { provider: true } } } },
          },
        },
      },
    });
    const connection = workspace?.computers[0];
    if (connection?.computer.runtimes.length) return connection;
    await Bun.sleep(1_000);
  }
  throw new Error(`no Computer runtime inventory found for workspace ${workspaceSlug}`);
}

async function waitForUsage(
  workspaceId: string,
  computerId: string,
  provider: "codex" | "claude-code",
  scanId: string,
) {
  const cache = getUsageCache();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await cache.get({ workspaceId, computerId, provider });
    if (result?.scanId === scanId && result.status !== "pending") return result;
    await Bun.sleep(100);
  }
  throw new Error(`provider usage scan timed out for ${provider}`);
}

function required(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
