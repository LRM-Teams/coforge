import type { PrismaClient } from "../../../generated/client";

/**
 * Provenance-edge neighborhood expansion (ADR 0052-I): the traversal engine
 * behind Memory Exploration steps. One hop from each anchor citation along
 * the requested edge classes; the exploration protocol drives further hops
 * with its own step budget.
 *
 * Edge classes:
 *  - interactions   raw layer: episodes joined through shared Interaction-Link
 *                   participant identities (agents/users, cross-channel — the
 *                   per-channel member id can never connect two channels);
 *  - episodeInsight raw ↔ wiki: the supports/contradicts provenance edges;
 *  - skillGrounding wiki → skill: insights/episodes grounding bound proposals
 *                   (bidirectional — a skill anchor walks back to its evidence);
 *  - skillLineage   skill layer: the supersedes chain within one lineage;
 *  - similar        the trigram similarity seam as a pseudo-edge (seeding's
 *                   ranking reused for neighborhood hops).
 */

export type MemoryCitationKind = "episode" | "insight" | "skill";

export type MemoryExpansionEdgeClass =
  | "similar"
  | "interactions"
  | "episodeInsight"
  | "skillGrounding"
  | "skillLineage";

export const MEMORY_EXPANSION_EDGE_CLASSES: MemoryExpansionEdgeClass[] = [
  "similar",
  "interactions",
  "episodeInsight",
  "skillGrounding",
  "skillLineage",
];

export type ExpansionSeed = { kind: MemoryCitationKind; id: string };

export type ExpansionNode = {
  kind: MemoryCitationKind;
  id: string;
  snippet: string;
  via: MemoryExpansionEdgeClass;
};

const MIN_SIMILARITY = 0.2;

export async function expandMemoryNeighborhood(
  db: PrismaClient,
  input: {
    workspaceId: string;
    seeds: ExpansionSeed[];
    limit?: number;
    edgeClasses?: MemoryExpansionEdgeClass[];
  },
): Promise<ExpansionNode[]> {
  const classes = new Set(input.edgeClasses ?? MEMORY_EXPANSION_EDGE_CLASSES);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
  const seen = new Set(input.seeds.map((seed) => `${seed.kind}:${seed.id}`));
  const collected: ExpansionNode[] = [];
  const push = (node: ExpansionNode) => {
    const key = `${node.kind}:${node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(node);
  };

  const episodeIds = input.seeds.filter((s) => s.kind === "episode").map((s) => s.id);
  const insightIds = input.seeds.filter((s) => s.kind === "insight").map((s) => s.id);
  const skillIds = input.seeds.filter((s) => s.kind === "skill").map((s) => s.id);

  if (classes.has("episodeInsight") && (episodeIds.length || insightIds.length)) {
    const rows = await db.$queryRaw<ExpansionNode[]>`
      SELECT 'insight' AS kind, i.id AS id, left(i.statement, 200) AS snippet, 'episodeInsight' AS via
      FROM memory_insight_episode_links l JOIN memory_insights i ON i.id = l."insightId"
      WHERE l."episodeId" = ANY(${episodeIds}::uuid[]) AND i."supersededById" IS NULL
      UNION
      SELECT 'episode' AS kind, e.id AS id, left(e.body, 200) AS snippet, 'episodeInsight' AS via
      FROM memory_insight_episode_links l JOIN memory_episodes e ON e.id = l."episodeId"
      WHERE l."insightId" = ANY(${insightIds}::uuid[])
    `;
    rows.forEach(push);
  }

  if (classes.has("interactions") && episodeIds.length) {
    const rows = await db.$queryRaw<ExpansionNode[]>`
      WITH frontier AS (
        SELECT "conversationId", "startSequence", "endSequence"
        FROM memory_episodes
        WHERE id = ANY(${episodeIds}::uuid[])
      ),
      end_members AS (
        SELECT m."senderMemberId" AS mid
        FROM memory_interaction_links il
        JOIN messages m ON m.id = il."fromMessageId"
        JOIN frontier f ON m."conversationId" = f."conversationId"
          AND m.sequence BETWEEN f."startSequence" AND f."endSequence"
        UNION
        SELECT il."toMemberId"
        FROM memory_interaction_links il
        JOIN messages m ON m.id = il."fromMessageId"
        JOIN frontier f ON m."conversationId" = f."conversationId"
          AND m.sequence BETWEEN f."startSequence" AND f."endSequence"
        UNION
        SELECT m2."senderMemberId"
        FROM memory_interaction_links il
        JOIN messages m ON m.id = il."fromMessageId"
        JOIN frontier f ON m."conversationId" = f."conversationId"
          AND m.sequence BETWEEN f."startSequence" AND f."endSequence"
        JOIN messages m2 ON m2.id = il."toMessageId"
      ),
      identities AS (
        SELECT cm."agentId" AS aid, cm."userId" AS uid
        FROM end_members em JOIN conversation_members cm ON cm.id = em.mid
        WHERE cm."agentId" IS NOT NULL OR cm."userId" IS NOT NULL
      )
      SELECT DISTINCT 'episode' AS kind, e.id AS id, left(e.body, 200) AS snippet, 'interactions' AS via
      FROM memory_episodes e
      JOIN LATERAL (
        SELECT cm."agentId" AS aid, cm."userId" AS uid
        FROM messages m JOIN conversation_members cm ON cm.id = m."senderMemberId"
        WHERE m."conversationId" = e."conversationId"
          AND m.sequence BETWEEN e."startSequence" AND e."endSequence"
          AND m."senderMemberId" IS NOT NULL
      ) senders ON true
      JOIN identities ids ON
        (ids.aid IS NOT NULL AND ids.aid = senders.aid)
        OR (ids.uid IS NOT NULL AND ids.uid = senders.uid)
      WHERE e."workspaceId" = ${input.workspaceId}::uuid
    `;
    rows.forEach(push);
  }

  if (
    classes.has("skillGrounding") &&
    (episodeIds.length || insightIds.length || skillIds.length)
  ) {
    const rows = await db.$queryRaw<ExpansionNode[]>`
      SELECT 'skill' AS kind, r.id AS id,
             s.name || ' v' || r.version AS snippet, 'skillGrounding' AS via
      FROM skill_proposal_groundings g
      JOIN skill_proposals p ON p.id = g."proposalId" AND p.status = 'bound'
      JOIN learned_skill_revisions r ON r."proposalId" = p.id AND r.state = 'active'
      JOIN learned_skills s ON s.id = r."skillId"
      WHERE g."workspaceId" = ${input.workspaceId}::uuid
        AND (g."episodeId" = ANY(${episodeIds}::uuid[]) OR g."insightId" = ANY(${insightIds}::uuid[]))
      UNION
      SELECT 'insight' AS kind, i.id AS id, left(i.statement, 200) AS snippet, 'skillGrounding' AS via
      FROM learned_skill_revisions r
      JOIN skill_proposals p ON p.id = r."proposalId" AND p.status = 'bound'
      JOIN skill_proposal_groundings g ON g."proposalId" = p.id AND g.kind = 'insight'
      JOIN memory_insights i ON i.id = g."insightId" AND i."supersededById" IS NULL
      WHERE r.id = ANY(${skillIds}::uuid[])
      UNION
      SELECT 'episode' AS kind, e.id AS id, left(e.body, 200) AS snippet, 'skillGrounding' AS via
      FROM learned_skill_revisions r
      JOIN skill_proposals p ON p.id = r."proposalId" AND p.status = 'bound'
      JOIN skill_proposal_groundings g ON g."proposalId" = p.id AND g.kind = 'episode'
      JOIN memory_episodes e ON e.id = g."episodeId"
      WHERE r.id = ANY(${skillIds}::uuid[])
    `;
    rows.forEach(push);
  }

  if (classes.has("skillLineage") && skillIds.length) {
    const rows = await db.$queryRaw<ExpansionNode[]>`
      SELECT 'skill' AS kind, r.id AS id, s.name || ' v' || r.version AS snippet, 'skillLineage' AS via
      FROM learned_skill_revisions anchor
      JOIN learned_skills s ON s.id = anchor."skillId"
      JOIN learned_skill_revisions r ON r."skillId" = anchor."skillId" AND r.id <> anchor.id
      WHERE anchor.id = ANY(${skillIds}::uuid[])
    `;
    rows.forEach(push);
  }

  if (classes.has("similar") && input.seeds.length) {
    const anchors = await loadAnchorTexts(db, input.workspaceId, input.seeds);
    for (const anchor of anchors) {
      if (collected.length >= limit) break;
      const rows = await db.$queryRaw<ExpansionNode[]>`
        WITH RECURSIVE chain AS (
          SELECT h.id AS "memberId", h.id AS "headId", h.statement AS statement
          FROM memory_insights h
          WHERE h."workspaceId" = ${input.workspaceId}::uuid AND h."supersededById" IS NULL
          UNION
          SELECT m.id, c."headId", m.statement
          FROM memory_insights m JOIN chain c ON m."supersededById" = c."memberId"
        ),
        active AS (
          SELECT c."headId" AS id, c.statement AS statement
          FROM chain c LEFT JOIN memory_score_events e ON e."insightId" = c."memberId"
          WHERE c."memberId" = c."headId"
          GROUP BY c."headId", c.statement
          HAVING COALESCE(SUM(e.delta), 0) > 0
        ),
        pool AS (
          SELECT 'episode' AS kind, e.id AS id, left(e.body, 200) AS snippet,
                 word_similarity(${anchor.text}, e.body) AS score
          FROM memory_episodes e WHERE e."workspaceId" = ${input.workspaceId}::uuid
          UNION ALL
          SELECT 'insight' AS kind, a.id AS id, left(a.statement, 200) AS snippet,
                 word_similarity(${anchor.text}, a.statement) AS score
          FROM active a
          UNION ALL
          SELECT 'skill' AS kind, r.id AS id, s.name || ' v' || r.version AS snippet,
                 word_similarity(${anchor.text}, r."searchText") AS score
          FROM learned_skill_revisions r
          JOIN learned_skills s ON s.id = r."skillId" AND s."currentRevisionId" = r.id
          WHERE r."workspaceId" = ${input.workspaceId}::uuid AND r.state = 'active'
        )
        SELECT kind, id, snippet, 'similar' AS via FROM pool
        WHERE score >= ${MIN_SIMILARITY}
        ORDER BY score DESC
        LIMIT ${limit}
      `;
      rows.forEach(push);
    }
  }

  return collected.slice(0, limit);
}

async function loadAnchorTexts(
  db: PrismaClient,
  workspaceId: string,
  seeds: ExpansionSeed[],
): Promise<Array<{ text: string }>> {
  const texts: Array<{ text: string }> = [];
  const episodeIds = seeds.filter((s) => s.kind === "episode").map((s) => s.id);
  const insightIds = seeds.filter((s) => s.kind === "insight").map((s) => s.id);
  const skillIds = seeds.filter((s) => s.kind === "skill").map((s) => s.id);
  if (episodeIds.length) {
    const rows = await db.$queryRaw<Array<{ text: string }>>`
      SELECT left(body, 2000) AS text FROM memory_episodes
      WHERE "workspaceId" = ${workspaceId}::uuid AND id = ANY(${episodeIds}::uuid[])`;
    texts.push(...rows);
  }
  if (insightIds.length) {
    const rows = await db.$queryRaw<Array<{ text: string }>>`
      SELECT statement AS text FROM memory_insights
      WHERE "workspaceId" = ${workspaceId}::uuid AND id = ANY(${insightIds}::uuid[])`;
    texts.push(...rows);
  }
  if (skillIds.length) {
    const rows = await db.$queryRaw<Array<{ text: string }>>`
      SELECT "searchText" AS text FROM learned_skill_revisions
      WHERE "workspaceId" = ${workspaceId}::uuid AND id = ANY(${skillIds}::uuid[])`;
    texts.push(...rows);
  }
  return texts;
}
