ALTER TABLE "causal_citation_records" ADD COLUMN "fact_version" INTEGER;

UPDATE "causal_citation_records"
SET "fact_version" = substring("causal_path_id" from '^__v([0-9]+)__')::integer
WHERE "causal_path_id" ~ '^__v[0-9]+__';

UPDATE "causal_citation_records"
SET "causal_path_id" = CASE
  WHEN "causal_path_id" ~ '^__v[0-9]+__:' THEN substring("causal_path_id" from '^__v[0-9]+__:(.*)$')
  ELSE NULL
END
WHERE "causal_path_id" ~ '^__v[0-9]+__';
