import type { OwnedChildProcess, OwnedProcessTree } from "#src/platform/process-tree";
import { AgentProcessCleanupError } from "./contract";

/** How long each rung of the cleanup ladder waits for the tree to exit. */
export const PROCESS_TREE_EXIT_GRACE_MS = 1_000;

/**
 * The one cleanup ladder a code-agent process runs over the tree it owns: ask politely, wait a
 * bounded moment, escalate to a forced terminate, wait again, and only then fail with
 * `AgentProcessCleanupError`; the child's stdin is closed afterwards so nothing can hold the tree
 * open. `JsonlProcess` and the per-turn `TurnProcess` both run it.
 *
 * What the caller waits on afterwards stays the caller's: a `TurnProcess` awaits its own `exited`
 * result, while `JsonlProcess` also waits for its adapter's diagnostics to drain.
 */
export async function cleanupOwnedTree(
  tree: OwnedProcessTree,
  child: OwnedChildProcess,
): Promise<void> {
  try {
    await tree.terminate(false);
  } catch {
    // A bounded tree check below determines whether cleanup was successful.
  }
  let treeExited: boolean;
  try {
    treeExited = await tree.waitForExit(PROCESS_TREE_EXIT_GRACE_MS);
  } catch {
    throw new AgentProcessCleanupError();
  }
  if (!treeExited) {
    try {
      await tree.terminate(true);
    } catch {
      // A bounded tree check below determines whether cleanup was successful.
    }
    try {
      treeExited = await tree.waitForExit(PROCESS_TREE_EXIT_GRACE_MS);
    } catch {
      throw new AgentProcessCleanupError();
    }
  }
  if (!treeExited) throw new AgentProcessCleanupError();
  try {
    child.stdin.end();
  } catch {
    // An exited child may have already closed stdin.
  }
}
