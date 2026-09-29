# Workspace deletion

A Workspace's owner deletes it from Settings → Workspace profile → Danger zone by typing its
slug. The delete is immediate and permanent: there is no recovery window and no soft delete, and
the dialog says it cannot be undone. This page states what goes and when. The code is
`apps/web/src/server/workspaces/deletion.server.ts`; its rules are in that directory's
`AGENTS.md`.

## Who can, and what refuses it

- Only the owner, and only with the Workspace's exact slug. Anyone else is refused; a Workspace
  already deleted (from another tab) answers "not found" and the page leaves it.
- Workspace memory that cannot be removed refuses the delete with "The Workspace's memory could
  not be deleted. Try again in a moment." (`TEMPORARILY_UNAVAILABLE`, error id
  `workspace-memory-removal-failed`), and the Workspace stays whole. See the next section.

## Workspace memory: first, before any row

A Workspace with an OpenViking binding, or with cleanup an earlier press left unfinished, has its
memory removed before anything else goes, so none of it outlives the Workspace:

1. The OpenViking account the binding names is deleted through the typed cleanup channel (a
   `404` counts as already gone).
2. The binding is removed, and the identities mapped under it with it.

This is one cleanup operation per Workspace (`workspace-deletion`, two targets, one lease of 30 s
each), so pressing Delete again resumes where a failed press stopped. A press is refused, with
the error above, when OpenViking fails or another press still holds the lease; the real cause is
in the log (`workspace_deletion:memory_removal_failed`), never in the answer.

- The Web process holds no OpenViking root credential, so the account delete has no admin
  identity to act as and a binding cannot be removed: the press is refused, and the log line
  `workspace_memory_cleanup:openviking_unconfigured` (cause `admin credential not wired`) says
  why. A Workspace with no binding needs none and makes no OpenViking call. Production has no
  binding today, because its memory provisioner is not the real one. When real account
  provisioning ships, where the credential lives is a security-boundary decision, and the same
  credential serves both provisioning and this delete.
- A binding that appears after its removal (memory provisioned again meanwhile) is found again
  under the locks below and refuses the delete the same way; the next press runs the removal
  again.
- The cleanup's own rows name the Workspace with `Restrict`, so the final transaction deletes
  them, settled or not.

## Database rows: during the request

Everything else is removed while the owner waits, before the dialog closes:

1. Messages, a batch of 5,000 per statement, together with what hangs off each (Tasks, Action
   cards, attachments rows, reactions, mentions, reads, saved messages). Members with the
   Workspace open may see messages disappear before the Workspace does.
2. One transaction for everything else: channels and direct messages, memberships, Agents and
   their Reminders, Projects, Records and weekly reports, Computer links and daemon keys. Each
   live daemon key is recorded as revoked first, so the Computer holding it learns why it stopped
   working.

Measured on local PostgreSQL 18: 420,000 messages (42,000 Tasks, 21,000 attachments) took 15.6 s
of batches and about 0.2 s in the final transaction; one transaction for 1,050,000 messages took
29.6 s. The request may run for up to 300 s (about eight million messages). If it fails after
the batches, the Workspace remains without those messages, and deleting it again finishes the
job.

## Right after: pages and Computers

- Every open page of the Workspace hears `workspace.deleted.v1` and goes to `/`, which opens the
  viewer's next Workspace. A page that missed it while reconnecting finds it can no longer
  subscribe to the Workspace, checks, and leaves too.
- Each attached Computer's live connection is disconnected so it reconnects at once, is refused
  with `workspace_deleted`, and parks the binding, stopping that Workspace's Agents. A Computer
  that is offline parks on its next connect.

## Stored files: in the background

Every object a Workspace writes is under `workspaces/<workspace_id>/` in the private files
bucket (attachments) and in the profile-image bucket (the Workspace icon, Project icons, Agent
avatars).

- Right after the delete: the objects its rows named are removed in batches of 1,000, then
  everything under the prefix. The owner's answer does not wait for this.
- 16 minutes later (the 15-minute presigned-upload lifetime plus a minute): the prefix is swept
  again, for an upload that was in flight during the delete.
- Best effort: a failure is logged and not retried. A restart of the Web server before the second
  sweep skips it; such a late object is never referenced or served. The prefix sweep needs
  `oss:ListObjects` on each bucket (see the staging
  [operator bootstrap](operations/staging/operator-bootstrap.md)).

## Backups

Database backup retention is not documented in this repository, so how long a deleted Workspace
survives in a backup is not stated here.
