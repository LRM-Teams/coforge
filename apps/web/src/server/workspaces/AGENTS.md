# Workspace server modules

These rules apply to `src/server/workspaces/`.

- `deletion.server.ts` (`WorkspaceDeletion`) is the one flow that hard-deletes a
  Workspace. What it removes and when is [Workspace deletion](../../../../../docs/workspace-deletion.md);
  change that page with the flow.
- Every refusal (owner, slug, memory state) happens before the first write, so a
  refused delete changes nothing.
- Messages go in batches before the final transaction; they are what makes a
  large Workspace slow (one FK trigger per row per referencing table).
- Lock conversations first, then the Workspace row, then the conversations again:
  the order every writer takes (conversation lock, then a key naming the
  Workspace). Retry only on a PostgreSQL write conflict, through
  `server/db/write-conflict.server.ts`.
- Memory Offer citations and messages are deleted before the Workspace: they name
  rows the same cascade removes with `Restrict`. A new `Restrict` or `NO ACTION`
  reference into the Workspace's cascade goes there too, or the delete fails;
  `test/workspace-delete.integration.test.ts` lists every such key and fails on a
  new one.
- An OpenViking binding refuses the delete (`workspace-memory-bound`), and so does
  memory cleanup not yet settled (`workspace-memory-cleanup-pending`); settled
  cleanup rows are deleted with the Workspace.
- Stored files go after the answer (`WorkspaceFileCleanup`), never awaited by it.
- A flow that hard-deletes a Workspace calls
  `DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId)` inside its
  transaction, before anything revokes or cascades the Workspace's daemon keys
  (only live keys are recorded), and logs the Workspace id with the count it
  returns. That record is the only way a Computer learns its Workspace is gone
  and parks the binding; without it the Computer retries forever. A soft delete
  that keeps the keys valid never parks a Computer.
