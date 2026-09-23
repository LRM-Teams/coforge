# Preference tables

## `user_preferences`

One row per user for account-level settings (time zone, time format, browser
notifications, conversation open mode), keyed by `userId` with `ON DELETE CASCADE`. Every setting
column is nullable and NULL means the code default; closed sets are TEXT with a
`CHECK` constraint.

## `workspace_member_preferences`

One row per Workspace membership for a member's own settings inside that Workspace, keyed by
`(workspaceId, userId)` with a foreign key to `workspace_memberships` and `ON DELETE CASCADE`.
`conversationTabOrder` and `agentProfileTabOrder` are `TEXT[]` tab-id lists (empty = default
order, first tab opens by default), each limited to its panel's ids by a `CHECK`.
