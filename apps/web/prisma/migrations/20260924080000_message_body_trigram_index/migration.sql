-- Message search matches bodies with case-insensitive substrings (ILIKE '%term%'), which a
-- trigram GIN index serves for any script, Chinese included. pg_trgm ships with PostgreSQL's
-- contrib modules and is a trusted extension, so the migration role can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "messages_body_idx" ON "messages" USING GIN ("body" gin_trgm_ops);
