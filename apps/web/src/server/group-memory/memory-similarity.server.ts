import type { PrismaClient } from "../../../generated/client";

/**
 * Group Memory similarity seam (ADR 0052): retrieval seeds come from *one*
 * interface so the lexical implementation can be replaced by an embedding
 * backend without touching any caller. The v1 implementation is PostgreSQL
 * pg_trgm `word_similarity` ranking — deterministic, cheap to test, and needs
 * no new credentials or extensions beyond pg_trgm. If recall quality
 * disappoints, this seam is the first thing to revisit.
 *
 * Deliberate divergence from the feat/group-memory branch: no derived
 * memory_graph_edges projection — expansion runs along provenance edges and
 * this seam only seeds (ADR 0052, Rejected alternatives).
 *
 * Seeds exclude, by construction: superseded insight rows, heads whose live
 * chain score is <= 0 (retired insights), and retired skill revisions.
 * Episodes are immutable and never retire.
 */

export type MemorySeedKind = "episode" | "insight" | "skill";

export type MemorySeed = {
  kind: MemorySeedKind;
  /** Episode id, insight head id, or learned-skill revision id (heads only). */
  id: string;
  /** Normalized trigram similarity in [0, 1]; higher = more similar. */
  score: number;
  /** Short text for display in an exploration session. */
  snippet: string;
};

export interface MemorySimilarityIndex {
  findSeeds(workspaceId: string, query: string, limit: number): Promise<MemorySeed[]>;
}

/** Lowest trigram similarity that may seed an exploration. Tunable seam knob. */
export const MIN_MEMORY_SEED_SIMILARITY = 0.15;

export function createTrgmSimilarityIndex(db: PrismaClient): MemorySimilarityIndex {
  return {
    async findSeeds(workspaceId, query, limit) {
      if (!query.trim()) return [];
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new Error("findSeeds limit must be an integer in [1, 50]");
      const rows = await db.$queryRaw<MemorySeed[]>`
        WITH RECURSIVE chain AS (
          SELECT h.id AS "memberId", h.id AS "headId", h.statement AS statement
          FROM memory_insights h
          WHERE h."workspaceId" = ${workspaceId}::uuid AND h."supersededById" IS NULL
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
        ranked AS (
          SELECT 'insight' AS kind, a.id AS id,
                 word_similarity(${query}, a.statement) AS score,
                 a.statement AS snippet
          FROM active a
          WHERE word_similarity(${query}, a.statement) >= ${MIN_MEMORY_SEED_SIMILARITY}
          UNION ALL
          SELECT 'episode' AS kind, e.id AS id,
                 word_similarity(${query}, e.body) AS score,
                 left(e.body, 280) AS snippet
          FROM memory_episodes e
          WHERE e."workspaceId" = ${workspaceId}::uuid
            AND word_similarity(${query}, e.body) >= ${MIN_MEMORY_SEED_SIMILARITY}
          UNION ALL
          SELECT 'skill' AS kind, r.id AS id,
                 word_similarity(${query}, r."searchText") AS score,
                 left(r."searchText", 280) AS snippet
          FROM learned_skill_revisions r
          JOIN learned_skills s ON s.id = r."skillId"
          WHERE r."workspaceId" = ${workspaceId}::uuid
            AND r.state = 'active'
            AND s."currentRevisionId" = r.id
            AND word_similarity(${query}, r."searchText") >= ${MIN_MEMORY_SEED_SIMILARITY}
        )
        SELECT kind, id, score, snippet FROM ranked
        ORDER BY score DESC, kind ASC
        LIMIT ${limit}
      `;
      return rows;
    },
  };
}
