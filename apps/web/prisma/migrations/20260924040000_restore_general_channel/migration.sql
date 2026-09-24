-- Bring the Workspace-wide #general channel back (Frank, 2026-09-24). Every Workspace gets one:
-- an archived #general is unarchived in place, keeping its history, and a Workspace without one
-- gets a new one. Every human member and every public, live Agent is in it — nobody leaves
-- #general. A human who joins or returns starts read through its latest message, so its history
-- is not unread for them; an Agent, as on any late join, can read the history but is notified only
-- of what is sent afterwards. Private Agents stay out of every channel. Safe to run more than once.

UPDATE "conversations"
SET "archivedAt" = NULL
WHERE "channelName" = 'general' AND "archivedAt" IS NOT NULL;

INSERT INTO "conversations" ("id", "workspaceId", "channelName")
SELECT gen_random_uuid(), w."id", 'general'
FROM "workspaces" w
WHERE NOT EXISTS (
  SELECT 1 FROM "conversations" c
  WHERE c."workspaceId" = w."id" AND c."channelName" = 'general'
);

WITH general AS (
  SELECT c."id", c."workspaceId", COALESCE(MAX(msg."sequence"), 0) AS "latest"
  FROM "conversations" c
  LEFT JOIN "messages" msg ON msg."conversationId" = c."id"
  WHERE c."channelName" = 'general'
  GROUP BY c."id", c."workspaceId"
),
people AS (
  SELECT g."id" AS "conversationId", g."workspaceId", g."latest", m."userId"
  FROM general g
  JOIN "workspace_memberships" m ON m."workspaceId" = g."workspaceId"
),
returning_people AS (
  UPDATE "conversation_members" cm
  SET "leftAt" = NULL, "readThroughSequence" = p."latest"
  FROM people p
  WHERE cm."conversationId" = p."conversationId"
    AND cm."userId" = p."userId"
    AND cm."leftAt" IS NOT NULL
  RETURNING cm."id"
)
INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "userId", "readThroughSequence")
SELECT gen_random_uuid(), p."conversationId", p."workspaceId", p."userId", p."latest"
FROM people p
WHERE NOT EXISTS (
  SELECT 1 FROM "conversation_members" cm
  WHERE cm."conversationId" = p."conversationId" AND cm."userId" = p."userId"
);

WITH live_agents AS (
  SELECT c."id" AS "conversationId", c."workspaceId", a."id" AS "agentId"
  FROM "conversations" c
  JOIN "agents" a ON a."workspaceId" = c."workspaceId"
  WHERE c."channelName" = 'general' AND a."visibility" = 'public' AND a."deletedAt" IS NULL
),
returning_agents AS (
  UPDATE "conversation_members" cm
  SET "leftAt" = NULL
  FROM live_agents la
  WHERE cm."conversationId" = la."conversationId"
    AND cm."agentId" = la."agentId"
    AND cm."leftAt" IS NOT NULL
  RETURNING cm."id"
)
INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "agentId")
SELECT gen_random_uuid(), la."conversationId", la."workspaceId", la."agentId"
FROM live_agents la
WHERE NOT EXISTS (
  SELECT 1 FROM "conversation_members" cm
  WHERE cm."conversationId" = la."conversationId" AND cm."agentId" = la."agentId"
);
