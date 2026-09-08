-- Move provider-native identity out of the launch fence without changing the
-- already-applied AgentSession binding migration.
INSERT INTO "agent_sessions" (
    "id", "agentId", "workspaceId", "computerId", "provider", "nativeSessionId", "state"
)
SELECT
    gen_random_uuid(),
    a."id",
    a."workspaceId",
    (a."runtimeSession"->>'computerId')::uuid,
    a."runtimeSession"->>'provider',
    a."runtimeSession"->>'sessionId',
    'unknown'
FROM "agents" a
WHERE a."currentSessionId" IS NULL
  AND a."runtimeSession"->>'computerId' IS NOT NULL
  AND a."runtimeSession"->>'provider' IS NOT NULL
  AND a."runtimeSession"->>'sessionId' IS NOT NULL;

UPDATE "agents" a
SET "currentSessionId" = s."id"
FROM "agent_sessions" s
WHERE s."agentId" = a."id"
  AND s."nativeSessionId" = a."runtimeSession"->>'sessionId'
  AND s."computerId" = (a."runtimeSession"->>'computerId')::uuid
  AND s."provider" = a."runtimeSession"->>'provider'
  AND a."currentSessionId" IS NULL;

UPDATE "agents"
SET "runtimeSession" = "runtimeSession" - 'sessionId' - 'state'
WHERE "runtimeSession" IS NOT NULL
  AND ("runtimeSession" ? 'sessionId' OR "runtimeSession" ? 'state');
