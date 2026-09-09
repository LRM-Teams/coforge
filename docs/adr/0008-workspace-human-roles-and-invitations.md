# ADR 0008: Workspace human roles and invitations

Status: accepted  
Date: 2026-09-09

## Context

CoForge previously treated Workspace presence as a binary membership with no
role field. Multica already ships `owner | admin | member` on human membership
plus pending invitations. CoForge needs the same collaboration boundary without
copying Multica's Channel roles, Agent `workspace_role`, or email-centric invite
identity.

## Decision

1. `WorkspaceMembership.role` is `owner`, `admin`, or `member`.
2. Creating a Workspace assigns the creator `owner`. Ownership is immutable:
   it cannot be invited, transferred, demoted, removed, or left.
3. `owner` and `admin` may invite existing Users by `@username` as `admin` or
   `member`, change `admin`↔`member`, revoke pending invitations, and remove
   non-owner members. Ordinary `member` may list peers and leave.
4. `WorkspaceInvitation` stores pending invites (7-day expiry). Acceptance
   creates membership and enrolls `#general`. Invite identity is the internal
   User id resolved from username, not email.
5. Agent ownership (`Agent.ownerId`) and Computer ownership remain separate
   from Workspace roles. Channel membership stays role-free.

## Rejected alternatives

- Instant add-without-consent membership: rejected; Multica's invite/accept
  flow matches consent and audit expectations.
- Invite by email with auto-created Users: rejected for CoForge; public
  identity is `@username` and Users already exist via Authing enrollment.
- Transferable ownership: deferred; Multica locks ownership and CoForge keeps
  that invariant until an explicit transfer decision exists.
- Agent workspace roles and Channel owner/manager/member: deferred; they are
  Multica product surfaces, not required for this slice.

## Consequences

- Existing rows are backfilled: prefer the member whose username matches the
  Workspace slug, otherwise the lexicographically first `userId`, as `owner`.
- Authorization helpers live in `member-role.server.ts`; membership workflows
  in `WorkspaceMemberDirectory`.
- Settings gains a Members section for list/invite/accept/role/remove/leave.
- Machine-level Daemon restart/upgrade remains independent of Workspace admin
  (see architecture §12); Workspace admin does not imply machine ownership.
