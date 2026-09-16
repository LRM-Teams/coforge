-- Enroll every existing Workspace human and Agent in #general once, so reads no
-- longer repair enrollment lazily; creation paths keep enrolling new rows.
INSERT INTO "conversations" ("id", "workspaceId", "channelName")
SELECT gen_random_uuid(), w."id", 'general'
FROM "workspaces" w
WHERE NOT EXISTS (
  SELECT 1 FROM "conversations" c
  WHERE c."workspaceId" = w."id" AND c."channelName" = 'general'
);

INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "userId")
SELECT gen_random_uuid(), c."id", m."workspaceId", m."userId"
FROM "workspace_memberships" m
JOIN "conversations" c ON c."workspaceId" = m."workspaceId" AND c."channelName" = 'general'
WHERE NOT EXISTS (
  SELECT 1 FROM "conversation_members" cm
  WHERE cm."conversationId" = c."id" AND cm."userId" = m."userId"
);

INSERT INTO "conversation_members" ("id", "conversationId", "workspaceId", "agentId")
SELECT gen_random_uuid(), c."id", a."workspaceId", a."id"
FROM "agents" a
JOIN "conversations" c ON c."workspaceId" = a."workspaceId" AND c."channelName" = 'general'
WHERE NOT EXISTS (
  SELECT 1 FROM "conversation_members" cm
  WHERE cm."conversationId" = c."id" AND cm."agentId" = a."id"
);
