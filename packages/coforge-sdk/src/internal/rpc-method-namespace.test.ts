import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LEGACY_RPC_METHOD_NAMES, RPC_METHODS } from "./rpc-methods";

/**
 * Guards the other half of an RPC method name: the namespace before its first colon.
 *
 * Centrifugo proxies a call only when that namespace is enabled for RPC in its own configuration,
 * and answers `104 method not found` *itself* when it is not — the call never reaches the backend,
 * whose answer to an unknown method is `404 unknown RPC method`. Nothing downstream can tell the
 * difference from a missing feature: the daemon retries a few times and gives up, the server never
 * records the event, and the user-visible symptom is a reminder (or any other callback) that
 * simply never fires. That is how `reminder:v1:fire`/`reminder:v1:snapshot` stayed broken from the
 * day the reminder scheduler shipped: the namespace was never listed.
 *
 * The two files below are the deployment's copy of the RPC namespace vocabulary, so this test owns
 * the invariant "every scope the wire uses is enabled everywhere it is deployed" — including the
 * pre-convention spellings an installed Computer still sends, because a namespace dropped one
 * release too early breaks exactly those clients and nothing else.
 */
const REPO_ROOT = join(import.meta.dir, "../../../..");

const CONFIGS: readonly string[] = [
  "infra/centrifugo/config.yaml",
  "infra/staging/centrifugo/config.yaml",
];

/** The `- name: <namespace>` entries of the top-level `rpc:` block's `namespaces:` list. */
export function rpcNamespaces(config: string): string[] {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^rpc:\s*$/.test(line));
  if (start < 0) throw new Error("no top-level rpc: block");
  const namespaces: string[] = [];
  let inNamespaces = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the rpc: block
    if (/^ {2}namespaces:\s*$/.test(line)) {
      inNamespaces = true;
      continue;
    }
    if (/^ {2}\S/.test(line)) inNamespaces = false; // another key under rpc:
    if (!inNamespaces) continue;
    const match = /^ {4}- name: (\S+)\s*$/.exec(line);
    if (match) namespaces.push(match[1]!);
  }
  return namespaces;
}

/** Every scope this module emits, in the order it first appears. */
function usedNamespaces(): string[] {
  return [
    ...new Set(
      [...Object.values(RPC_METHODS), ...Object.values(LEGACY_RPC_METHOD_NAMES)].map((method) => {
        const colon = method.indexOf(":");
        if (colon <= 0) throw new Error(`method without a namespace: ${method}`);
        return method.slice(0, colon);
      }),
    ),
  ];
}

for (const path of CONFIGS) {
  test(`${path} enables every namespace the wire uses`, async () => {
    const namespaces = rpcNamespaces(await readFile(join(REPO_ROOT, path), "utf8"));
    // A parse that silently returns nothing would make the assertion below vacuous.
    expect(namespaces.length).toBeGreaterThan(0);
    expect(usedNamespaces().filter((scope) => !namespaces.includes(scope))).toEqual([]);
  });
}

test("the parser reads the namespaces it is asserting about", () => {
  expect(
    rpcNamespaces("rpc:\n  namespaces:\n    - name: agent\n      proxy_enabled: true\n"),
  ).toEqual(["agent"]);
  expect(
    rpcNamespaces("rpc:\n  namespaces:\n    - name: agent\n  other:\n    - name: notanamespace\n"),
  ).toEqual(["agent"]);
});
