import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { FetchImpl } from "#src/server/openviking/runtime-client.server";
import {
  WORKSPACE_DELETION_CLEANUP_OWNER,
  createProductionWorkspaceMemoryCleanupRemotes,
} from "./cleanup-remotes.server";

const ADMIN_KEY = "root-key-held-by-the-server";
const URL_BASE = "http://ov.internal:1933";
const ADMIN_IDENTITY = {
  accountId: "root",
  userId: "cleanup-admin",
  role: "admin",
  authorization: `Bearer ${ADMIN_KEY}`,
} as const;

let warned: string[];
let restoreWarn: () => void;

beforeEach(() => {
  warned = [];
  const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
    warned.push(String(line));
  });
  restoreWarn = () => spy.mockRestore();
});

afterEach(() => {
  restoreWarn();
});

/** Bindings held in memory: the Prisma adapter is covered by the Workspace deletion suite. */
function memoryBindings(accountIds: Record<string, string> = {}) {
  const held = new Map(Object.entries(accountIds));
  return {
    held,
    async get(workspaceId: string) {
      const accountId = held.get(workspaceId);
      return accountId === undefined ? null : { accountId };
    },
    async remove(workspaceId: string) {
      held.delete(workspaceId);
    },
  };
}

/** Remotes given an admin identity, as a test (or a future provisioner) hands one in; without
 * `fetchImpl` any request fails the test. */
function remotesOver(options: {
  bindings: ReturnType<typeof memoryBindings>;
  fetchImpl?: FetchImpl;
}) {
  return createProductionWorkspaceMemoryCleanupRemotes({
    bindings: options.bindings,
    openviking: {
      baseUrl: URL_BASE,
      adminIdentity: ADMIN_IDENTITY,
      fetchImpl:
        options.fetchImpl ??
        (async () => {
          throw new Error("OpenViking must not be reached");
        }),
    },
  });
}

const input = { workspaceId: "ws-a", operationId: "workspace-deletion" };
const owner = WORKSPACE_DELETION_CLEANUP_OWNER;

test("the bound account is deleted through the typed channel with the key the server holds", async () => {
  const requests: { url: string; method?: string; authorization: string | null }[] = [];
  const remotes = remotesOver({
    bindings: memoryBindings({ "ws-a": "acct-ws-a" }),
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, { status: 202 });
    },
  });

  expect(await remotes.deleteOpenVikingAccount({ ...input, owner })).toEqual({ ok: true });
  expect(requests).toEqual([
    {
      url: `${URL_BASE}/api/v1/admin/accounts/acct-ws-a`,
      method: "DELETE",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
  ]);
});

test("an account OpenViking answers 404 for counts as deleted", async () => {
  const remotes = remotesOver({
    bindings: memoryBindings({ "ws-a": "acct-ws-a" }),
    fetchImpl: async () => new Response("no such account", { status: 404 }),
  });
  expect(await remotes.deleteOpenVikingAccount({ ...input, owner })).toEqual({ ok: true });
});

test("only the cleanup owner of a Workspace deletion may delete an account", async () => {
  const remotes = remotesOver({ bindings: memoryBindings({ "ws-a": "acct-ws-a" }) });
  expect(await remotes.deleteOpenVikingAccount({ ...input, owner: "someone-else" })).toEqual({
    ok: false,
    sanitizedError: "cleanup owner is not authorized",
  });
});

test("a Workspace with no binding has no account and needs no OpenViking at all", async () => {
  const remotes = createProductionWorkspaceMemoryCleanupRemotes({ bindings: memoryBindings() });
  expect(await remotes.deleteOpenVikingAccount({ ...input, owner })).toEqual({ ok: true });
  expect(await remotes.removeBinding(input)).toEqual({ ok: true });
  expect(warned).toEqual([]);
});

test("a binding with no admin credential wired fails, and the log says so", async () => {
  const remotes = createProductionWorkspaceMemoryCleanupRemotes({
    bindings: memoryBindings({ "ws-a": "acct-ws-a" }),
  });

  expect(await remotes.deleteOpenVikingAccount({ ...input, owner })).toEqual({
    ok: false,
    sanitizedError: "openviking admin credential not wired",
  });
  expect(warned.map((line) => JSON.parse(line))).toEqual([
    {
      event: "workspace_memory_cleanup:openviking_unconfigured",
      workspace_id: "ws-a",
      cause: "admin credential not wired",
    },
  ]);
});

test("an OpenViking that fails is reported as failed, and neither result nor log carries the key", async () => {
  for (const fetchImpl of [
    async () => new Response(`denied ${ADMIN_KEY}`, { status: 500 }),
    async () => {
      throw new Error(`ECONNREFUSED Bearer ${ADMIN_KEY}`);
    },
  ] satisfies FetchImpl[]) {
    const remotes = remotesOver({ bindings: memoryBindings({ "ws-a": "acct-ws-a" }), fetchImpl });
    const result = await remotes.deleteOpenVikingAccount({ ...input, owner });
    expect(result).toEqual({ ok: false, sanitizedError: "openviking account delete failed" });
    expect(JSON.stringify([result, ...warned])).not.toContain(ADMIN_KEY);
  }
});

test("removing the binding removes it once and is a success when it is already gone", async () => {
  const bindings = memoryBindings({ "ws-a": "acct-ws-a", "ws-b": "acct-ws-b" });
  const remotes = createProductionWorkspaceMemoryCleanupRemotes({ bindings });

  expect(await remotes.removeBinding(input)).toEqual({ ok: true });
  expect(await remotes.removeBinding(input)).toEqual({ ok: true });
  expect([...bindings.held.keys()]).toEqual(["ws-b"]);
});
