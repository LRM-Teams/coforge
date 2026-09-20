import { createHash } from "node:crypto";
import { AppError } from "../../lib/app-error";

/**
 * LearnedSkill artifact bodies (ADR 0052-F): the reference stack's
 * skill-artifact/2.0 model, reduced to the two v1 kinds. Bodies are closed
 * schemas validated before admission; evidence lives in the proposal
 * grounding edges (ADR 0052-I), never duplicated in the body. Identity is
 * the sha256 digest over the canonical JSON of {kind, body}.
 */

export type SkillArtifactKind = "step_guidance" | "procedure";

export type StepGuidanceFact = { fact_id: string; statement: string };

export type StepGuidanceBranch = {
  branch_id: string;
  when: { explanation: string };
  action: { instructions: string[]; rationale: string };
  future: { disposition: "success" | "failure_risk"; critical_steps: string[] };
};

export type StepGuidanceBody = {
  causal_context: { facts: StepGuidanceFact[] };
  branches: StepGuidanceBranch[];
};

export type ProcedureBody = {
  preconditions?: string[];
  instructions: string[];
  postconditions?: string[];
};

export type SkillArtifactBody = StepGuidanceBody | ProcedureBody;

const KINDS = new Set<SkillArtifactKind>(["step_guidance", "procedure"]);
const DISPOSITIONS = new Set(["success", "failure_risk"]);

const MAX_TEXT = 2000;
const MAX_FACTS = 20;
const MAX_BRANCHES = 16;
const MAX_INSTRUCTIONS = 30;
const MAX_BODY_BYTES = 32 * 1024;

/** Deterministic JSON: sorted keys, no whitespace — the digest preimage. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}

/** sha256 content identity over the canonical {kind, body} document. */
export function skillArtifactDigest(kind: SkillArtifactKind, body: SkillArtifactBody): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ kind, body })).digest("hex")}`;
}

/**
 * Validate one artifact body against the closed schema. Throws AppError
 * INVALID_INPUT with an ls-artifact-* errorId naming the first violation —
 * the canonicalizer maps these to ledger rejection reasons.
 */
export function validateSkillArtifactBody(
  kind: SkillArtifactKind,
  body: unknown,
): SkillArtifactBody {
  if (!KINDS.has(kind)) throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-kind" });
  if (!body || typeof body !== "object")
    throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-body" });
  const bytes = JSON.stringify(body).length;
  if (bytes > MAX_BODY_BYTES) throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-size" });
  if (kind === "procedure") return validateProcedure(body);
  return validateStepGuidance(body);
}

function validateProcedure(body: unknown): ProcedureBody {
  const record = body as Partial<ProcedureBody>;
  const instructions = requireStrings(
    record.instructions,
    "ls-artifact-instructions",
    MAX_INSTRUCTIONS,
    1,
  );
  const preconditions =
    record.preconditions === undefined
      ? undefined
      : requireStrings(record.preconditions, "ls-artifact-preconditions", MAX_INSTRUCTIONS, 0);
  const postconditions =
    record.postconditions === undefined
      ? undefined
      : requireStrings(record.postconditions, "ls-artifact-postconditions", MAX_INSTRUCTIONS, 0);
  const result: ProcedureBody = { instructions };
  if (preconditions) result.preconditions = preconditions;
  if (postconditions) result.postconditions = postconditions;
  return result;
}

function validateStepGuidance(body: unknown): StepGuidanceBody {
  const record = body as Partial<StepGuidanceBody>;
  const context = record.causal_context;
  if (!context || !Array.isArray(context.facts))
    throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-facts" });
  if (context.facts.length < 1 || context.facts.length > MAX_FACTS)
    throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-facts" });
  const factIds = new Set<string>();
  const facts: StepGuidanceFact[] = context.facts.map((fact) => {
    if (!fact || typeof fact !== "object")
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-fact" });
    const factId = requireText(fact.fact_id, "ls-artifact-fact-id", 200);
    if (factIds.has(factId))
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-fact-id" });
    factIds.add(factId);
    return {
      fact_id: factId,
      statement: requireText(fact.statement, "ls-artifact-fact-statement"),
    };
  });

  const branchesRaw = record.branches;
  if (!Array.isArray(branchesRaw) || branchesRaw.length < 1 || branchesRaw.length > MAX_BRANCHES)
    throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branches" });
  const branchIds = new Set<string>();
  const branches: StepGuidanceBranch[] = branchesRaw.map((branch) => {
    if (!branch || typeof branch !== "object")
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch" });
    const branchId = requireText(branch.branch_id, "ls-artifact-branch-id", 200);
    if (branchIds.has(branchId))
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch-id" });
    branchIds.add(branchId);
    const when = branch.when;
    if (!when || typeof when !== "object")
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch-when" });
    const action = branch.action;
    if (!action || typeof action !== "object")
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch-action" });
    const future = branch.future;
    if (!future || typeof future !== "object")
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch-future" });
    const disposition = future.disposition;
    if (!DISPOSITIONS.has(String(disposition)))
      throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-branch-disposition" });
    return {
      branch_id: branchId,
      when: { explanation: requireText(when.explanation, "ls-artifact-branch-when") },
      action: {
        instructions: requireStrings(
          action.instructions,
          "ls-artifact-branch-instructions",
          MAX_INSTRUCTIONS,
          1,
        ),
        rationale: requireText(action.rationale, "ls-artifact-branch-rationale"),
      },
      future: {
        disposition: disposition as StepGuidanceBranch["future"]["disposition"],
        critical_steps: requireStrings(
          future.critical_steps,
          "ls-artifact-branch-steps",
          MAX_INSTRUCTIONS,
          1,
        ),
      },
    };
  });
  return { causal_context: { facts }, branches };
}

function requireText(value: unknown, errorId: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError("INVALID_INPUT", { errorId });
  return value.trim();
}

function requireStrings(value: unknown, errorId: string, max: number, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new AppError("INVALID_INPUT", { errorId });
  return value.map((entry) => requireText(entry, errorId));
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validateSkillKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new AppError("INVALID_INPUT", { errorId: "ls-artifact-key" });
  return key;
}

export function validateSkillName(name: string): string {
  return requireText(name, "ls-artifact-name", 200);
}

/** Denormalized retrieval text for the trigram seam. */
export function buildSkillSearchText(
  name: string,
  kind: SkillArtifactKind,
  body: SkillArtifactBody,
): string {
  if (kind === "procedure") {
    const procedure = body as ProcedureBody;
    return [
      name,
      ...(procedure.preconditions ?? []),
      ...procedure.instructions,
      ...(procedure.postconditions ?? []),
    ].join("\n");
  }
  const guidance = body as StepGuidanceBody;
  return [
    name,
    ...guidance.causal_context.facts.map((fact) => fact.statement),
    ...guidance.branches.flatMap((branch) => [
      branch.when.explanation,
      ...branch.action.instructions,
    ]),
  ].join("\n");
}

/**
 * Render the SKILL.md-compatible guidance view served inside Memory Offers
 * (ADR 0052-E). Storage stays structured; this is the delivery-time render.
 */
export function renderSkillMarkdown(input: {
  name: string;
  key: string;
  kind: SkillArtifactKind;
  version: number;
  body: SkillArtifactBody;
}): string {
  const lines: string[] = [
    `# ${input.name}`,
    "",
    `Skill \`${input.key}\` v${input.version} (${input.kind})`,
    "",
  ];
  if (input.kind === "procedure") {
    const procedure = input.body as ProcedureBody;
    if (procedure.preconditions?.length) {
      lines.push("## Before you start", "");
      procedure.preconditions.forEach((entry) => lines.push(`- ${entry}`));
      lines.push("");
    }
    lines.push("## Instructions", "");
    procedure.instructions.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`));
    lines.push("");
    if (procedure.postconditions?.length) {
      lines.push("## Verify afterwards", "");
      procedure.postconditions.forEach((entry) => lines.push(`- ${entry}`));
      lines.push("");
    }
    return lines.join("\n");
  }
  const guidance = input.body as StepGuidanceBody;
  lines.push("## What this is about", "");
  guidance.causal_context.facts.forEach((fact) =>
    lines.push(`- ${fact.statement} (${fact.fact_id})`),
  );
  lines.push("");
  lines.push("## Decision branches", "");
  for (const branch of guidance.branches) {
    lines.push(`### ${branch.branch_id}`);
    lines.push("");
    lines.push(`**When:** ${branch.when.explanation}`);
    lines.push("");
    branch.action.instructions.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
    lines.push(`**Why:** ${branch.action.rationale}`);
    lines.push("");
    lines.push(
      `**Expected path (${branch.future.disposition}):** ${branch.future.critical_steps.join(" → ")}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
