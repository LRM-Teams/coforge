# Workspace server modules

These rules apply to `src/server/workspaces/`.

- `deletion.server.ts` (`WorkspaceDeletion`) is the one flow that hard-deletes a
  Workspace. It deletes messages and Memory Offer citations before the Workspace:
  they name rows the same cascade removes with `Restrict`. A new `Restrict`
  reference inside a Workspace goes there too, or the delete fails;
  `test/workspace-delete.integration.test.ts` lists every such key and fails on a
  new one.
- A Workspace whose memory still has OpenViking state (a binding or
  `workspace_memory_cleanup_work` rows) is refused with `CONFLICT`: only the
  memory module's own cleanup removes that state.
- A flow that hard-deletes a Workspace calls
  `DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId)` inside its
  transaction, before anything revokes or cascades the Workspace's daemon keys
  (only live keys are recorded), and logs the Workspace id with the count it
  returns. That record is the only way a Computer learns its Workspace is gone
  and parks the binding; without it the Computer retries forever. A soft delete
  that keeps the keys valid never parks a Computer.
