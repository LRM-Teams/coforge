import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentApiRoutes } from "@lrm/coforge-sdk/agent";

/**
 * The Agent API has two statements of itself: `agentApiRoutes` (the contract clients and the Daemon
 * proxy build URLs from) and the file routes under `src/routes/api/agent/v1/`, which are what
 * actually answers. Nothing tied them together, so a route could exist on one side only — which is
 * how `attachments/capabilities` came to be reached by borrowing the attachment *id* route, and how
 * `inbox` and `version` looked like web routes that were simply never written.
 *
 * This pins the two sets to each other. It compares **paths**, not methods: a web route file's
 * `createFileRoute` string does not say which verbs it handles, and the contract's method is a
 * per-entry fact that its own tests already cover.
 */

/** Two normalisations are needed before the sets can be compared at all. A parameter is written
 * `$channel` in a file route and `$channelId` in the contract — the same path, so parameters become
 * one `$`; and TanStack escapes a segment that also names a directory with a trailing `_`
 * (`channels_/$channel`), which is not part of the path. */
function shape(path: string): string {
  return path
    .replaceAll("__param__", "$")
    .split("/")
    .map((segment) => {
      const named = segment.replace(/_$/, "");
      return named.startsWith("$") ? "$" : named;
    })
    .join("/")
    .replace(/\/$/, "");
}

function contractShapes(value: unknown, shapes: Set<string>): Set<string> {
  if (!value || typeof value !== "object") return shapes;
  const record = value as Record<string, unknown>;
  // A path-bearing node is a route. `method` is not required: `messages.reactions` holds the path
  // for its `add`/`remove` children, which carry only the verbs.
  const path = record.path;
  if (typeof path === "string") shapes.add(shape(path));
  else if (typeof path === "function") shapes.add(shape(path("__param__")));
  for (const [key, child] of Object.entries(record)) {
    if (key === "path" || key === "method") continue;
    contractShapes(child, shapes);
  }
  return shapes;
}

async function webRouteShapes(): Promise<Set<string>> {
  const root = join(import.meta.dir, "..", "src", "routes", "api", "agent", "v1");
  const shapes = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/createFileRoute\("(\/api\/agent\/v1[^"]*)"\)/g))
          shapes.add(shape(match[1]!));
      }
    }
  };
  await walk(root);
  return shapes;
}

/** Contract routes no web route file serves, each with the reason one is not needed. The reason is
 * the point: an exemption without one is a silence, which is what this test exists to remove. */
const NOT_SERVED_BY_WEB = new Map([
  [
    "/api/agent/v1/version",
    "answered entirely by the Daemon's Agent proxy and never forwarded (comment on proxy.version)",
  ],
  [
    "/api/agent/v1/inbox",
    "DaemonRuntime.inbox() assembles it from the Agent's own state and never forwards it (comment on proxy.inbox)",
  ],
]);

/** Web routes the contract does not declare. Empty: every route served here is a contract member. */
const NOT_IN_CONTRACT = new Map<string, string>([]);

test("every contract route is served by a web route file, and every web route is in the contract", async () => {
  const contract = contractShapes(agentApiRoutes, new Set());
  const web = await webRouteShapes();

  // A parsing failure would empty one side and make everything look like a difference; the counts
  // are here so that cannot pass silently.
  expect(contract.size).toBeGreaterThanOrEqual(30);
  expect(web.size).toBeGreaterThanOrEqual(30);

  const unserved = [...contract].filter((path) => !web.has(path) && !NOT_SERVED_BY_WEB.has(path));
  const undeclared = [...web].filter((path) => !contract.has(path) && !NOT_IN_CONTRACT.has(path));
  expect({ unserved, undeclared }).toEqual({ unserved: [], undeclared: [] });
});

test("an exemption stays honest: it must still be missing from the other side", async () => {
  const contract = contractShapes(agentApiRoutes, new Set());
  const web = await webRouteShapes();

  // Once one of these is served (or declared), the exemption is dead weight and hides the next
  // difference; fail here so it is deleted rather than left to rot.
  for (const [path, reason] of NOT_SERVED_BY_WEB)
    expect({ path, reason, servedByWeb: web.has(path) }).toEqual({
      path,
      reason,
      // `attachments/capabilities` reached the contract this way: it was web-only until declared.
      servedByWeb: false,
    });
  for (const [path, reason] of NOT_IN_CONTRACT)
    expect({ path, reason, declared: contract.has(path) }).toEqual({
      path,
      reason,
      declared: false,
    });
});
