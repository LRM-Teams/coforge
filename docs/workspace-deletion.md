# Workspace deletion

A Workspace's owner deletes it from Settings → Workspace profile → Danger zone by typing its
slug. The delete is immediate and permanent: there is no recovery window and no soft delete, and
the dialog says it cannot be undone. This page states what goes and when. The code is
`apps/web/src/server/workspaces/deletion.server.ts`; its rules are in that directory's
`AGENTS.md`.

## Who can, and what refuses it

- Only the owner, and only with the Workspace's exact slug. Anyone else is refused; a Workspace
  already deleted (from another tab) answers "not found" and the page leaves it.
- Workspace memory still holding state outside CoForge refuses the delete and nothing changes: an
  OpenViking binding (an operator removes it), or memory cleanup not yet finished (try again
  later). Cleanup that has finished does not refuse it.

## Database rows: during the request

Everything is removed while the owner waits, before the dialog closes:

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
