import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import { createOpenVikingPolicyGateway } from "../src/server/openviking/policy-gateway.server";
import type { OpenVikingRuntimeRequest } from "../src/server/openviking/runtime-client.server";
import { createFakeOpenVikingProvisioner } from "../src/server/openviking/stores";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../src/server/workspace-memory/profile";
import { saveProfileTransition } from "../src/server/workspace-memory/stores";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("OpenViking policy-gateway");

const now = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };
const SERVER_AUTHORIZATION = "Bearer server-held-ov-key";

async function openHarness() {
  const pool = new Pool({ connectionString });
  const schema = `ov_gw_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceId = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceId] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    client,
    workspaceId,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings: new PrismaOpenVikingBindingStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

test.skipIf(!connectionString)(
  "Prisma profile/binding stores only allow forward once the workspace is ready",
  async () => {
    const harness = await openHarness();
    const calls: Array<{ method: string; path: string }> = [];
    try {
      const seed = createDefaultWorkspaceMemoryProfile(harness.workspaceId);
      const selected = applyWorkspaceMemoryCommand(
        seed,
        { type: "select_desired", desired: "openviking", at: now },
        enabled,
      );
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error(selected.failure.code);
      expect(await saveProfileTransition(harness.profiles, seed, selected.profile)).toBe("saved");

      const runtime = {
        async request(input: OpenVikingRuntimeRequest) {
          calls.push({ method: input.method, path: input.path });
          return {
            ok: true as const,
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"results":[]}'));
                  controller.close();
                },
              }),
            },
          };
        },
      };
      const gateway = createOpenVikingPolicyGateway({
        profiles: harness.profiles,
        bindings: harness.bindings,
        runtime,
        resolveAuthorization: async () => SERVER_AUTHORIZATION,
      });

      const unready = await gateway.forward(
        { kind: "owner", userId: "u-1" },
        {
          workspaceId: harness.workspaceId,
          method: "POST",
          path: "/api/v1/search/find",
        },
      );
      expect(unready.ok).toBe(false);
      if (!unready.ok) expect(unready.failure.code).toBe("workspace_not_ready");
      expect(calls).toEqual([]);

      const ready = applyWorkspaceMemoryCommand(selected.profile, {
        type: "observe_ready",
        generation: selected.profile.generation,
      });
      expect(ready.ok).toBe(true);
      if (!ready.ok) throw new Error(ready.failure.code);
      expect(await saveProfileTransition(harness.profiles, selected.profile, ready.profile)).toBe(
        "saved",
      );
      const binding = await createFakeOpenVikingProvisioner().provisionBinding({
        workspaceId: harness.workspaceId,
        generation: ready.profile.generation,
      });
      expect(
        await harness.bindings.compareAndSet({
          workspaceId: harness.workspaceId,
          expectedGeneration: 0,
          binding,
        }),
      ).toBe("saved");

      const allowed = await gateway.forward(
        { kind: "member", userId: "u-3" },
        {
          workspaceId: harness.workspaceId,
          method: "POST",
          path: "/api/v1/search/find",
          body: JSON.stringify({ query: "alpha" }),
        },
      );
      expect(allowed.ok).toBe(true);
      expect(calls).toEqual([{ method: "POST", path: "/api/v1/search/find" }]);

      const denied = await gateway.forward(
        { kind: "owner", userId: "u-1" },
        {
          workspaceId: harness.workspaceId,
          method: "GET",
          path: "/mcp",
        },
      );
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.failure.code).toBe("route_denied");
      expect(calls).toEqual([{ method: "POST", path: "/api/v1/search/find" }]);
      expect(JSON.stringify({ allowed, denied, binding })).not.toContain(SERVER_AUTHORIZATION);
      expect(JSON.stringify(binding)).not.toContain("plaintext");
    } finally {
      await harness.dispose();
    }
  },
);
