#!/usr/bin/env bun
/**
 * Deployment identity helpers for the coforge-staging Compose project.
 *
 * The canonical contract lives in docs/release.md ("Release identity and
 * evidence" and "Audit records"): one immutable image per `main` commit,
 * the previous healthy digest recorded before every mutation, and one
 * audit record per attempt. Secrets never enter this module, its inputs,
 * or the records it renders.
 */

const SHA_256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

export interface ImmutableImage {
  readonly reference: string;
  readonly digest: string;
}

/** Validates a full `repository@sha256:...` reference and rejects mutable tags. */
export function parseImmutableImage(reference: string): ImmutableImage {
  const trimmed = reference.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new InvalidImageError("image reference is missing an immutable digest");
  }
  const digest = trimmed.slice(separator + 1);
  if (!SHA_256_PATTERN.test(digest)) {
    throw new InvalidImageError("digest is not an immutable sha256 digest");
  }
  return { reference: trimmed, digest };
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export interface DeploymentState {
  /** Current healthy web image; null while the environment is empty (bootstrap). */
  readonly currentWebImage: string | null;
  /** Previous healthy web image, the rollback target. */
  readonly previousWebImage: string | null;
}

const STATE_KEYS = ["CURRENT_WEB_IMAGE", "PREVIOUS_WEB_IMAGE"] as const;

function parseOptionalImage(key: string, value: string): string | null {
  if (value === "") return null;
  parseImmutableImage(value);
  return value;
}

/** Fails closed on malformed or unknown state; never falls back to a guess. */
export function parseState(content: string): DeploymentState {
  const values = new Map<string, string>();
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new InvalidStateError("state line is missing a value");
    }
    const key = line.slice(0, separator);
    if (!STATE_KEYS.includes(key as (typeof STATE_KEYS)[number])) {
      throw new InvalidStateError(`unknown state key`);
    }
    if (values.has(key)) {
      throw new InvalidStateError("duplicate state key");
    }
    values.set(key, line.slice(separator + 1));
  }
  for (const key of STATE_KEYS) {
    if (!values.has(key)) {
      throw new InvalidStateError(`state is missing ${key}`);
    }
  }
  return {
    currentWebImage: parseOptionalImage("CURRENT_WEB_IMAGE", values.get("CURRENT_WEB_IMAGE") ?? ""),
    previousWebImage: parseOptionalImage(
      "PREVIOUS_WEB_IMAGE",
      values.get("PREVIOUS_WEB_IMAGE") ?? "",
    ),
  };
}

export function renderState(state: DeploymentState): string {
  const lines = [
    `CURRENT_WEB_IMAGE=${state.currentWebImage ?? ""}`,
    `PREVIOUS_WEB_IMAGE=${state.previousWebImage ?? ""}`,
  ];
  return `${lines.join("\n")}\n`;
}

export type DeploymentOutcome = "healthy" | "rolled_back" | "failed" | "bootstrap_failed";

export const DEPLOYMENT_OUTCOMES: readonly DeploymentOutcome[] = [
  "healthy",
  "rolled_back",
  "failed",
  "bootstrap_failed",
];

export interface DeploymentRecord {
  readonly deployment_id: string;
  readonly source_commit: string;
  readonly track: "cloud";
  readonly artifact_identity: string;
  readonly environment: "staging" | "production";
  readonly workflow_run: string;
  readonly previous_digest: string | null;
  readonly rollback_target: string | null;
  readonly health_result: string;
  readonly approval: null;
  readonly executor: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly outcome: DeploymentOutcome;
}

const RECORD_KEYS = [
  "deployment_id",
  "source_commit",
  "track",
  "artifact_identity",
  "environment",
  "workflow_run",
  "previous_digest",
  "rollback_target",
  "health_result",
  "approval",
  "executor",
  "started_at",
  "completed_at",
  "outcome",
] as const;

function keyOf(record: DeploymentRecord, key: (typeof RECORD_KEYS)[number]): unknown {
  return record[key];
}

/** Renders one audit line with a fixed key order; unknown fields never leak in. */
export function renderAuditRecord(record: DeploymentRecord): string {
  const parsedImage = parseImmutableImage(record.artifact_identity);
  if (record.track !== "cloud") {
    throw new Error("cloud deployment records only");
  }
  if (record.approval !== null) {
    throw new Error("test deployments never carry an approval");
  }
  if (!DEPLOYMENT_OUTCOMES.includes(record.outcome)) {
    throw new Error(`unknown outcome`);
  }
  if (record.previous_digest !== null && !SHA_256_PATTERN.test(record.previous_digest)) {
    throw new InvalidImageError("previous digest is not an immutable sha256 digest");
  }
  const ordered: Record<string, unknown> = {};
  for (const key of RECORD_KEYS) {
    ordered[key] = keyOf(record, key);
  }
  ordered.artifact_identity = parsedImage.reference;
  return `${JSON.stringify(ordered)}\n`;
}

export interface RemoteOutputs {
  readonly previousWebImage: string | null;
  readonly healthResult: string;
  readonly outcome: string;
  readonly rollbackTarget: string | null;
}

const OUTPUT_KEYS = ["previous_web_image", "health_result", "outcome", "rollback_target"];

/** Strictly parses the remote deploy script's key=value report. */
export function parseRemoteOutputs(content: string): RemoteOutputs {
  const values = new Map<string, string>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("remote output line is malformed");
    }
    const key = line.slice(0, separator);
    if (!OUTPUT_KEYS.includes(key)) {
      throw new Error(`unexpected remote output key`);
    }
    if (values.has(key)) {
      throw new Error("duplicate remote output key");
    }
    values.set(key, line.slice(separator + 1));
  }
  for (const key of OUTPUT_KEYS) {
    if (!values.has(key)) {
      throw new Error(`remote outputs are missing ${key}`);
    }
  }
  return {
    previousWebImage: parseOptionalImage("previous", values.get("previous_web_image") ?? ""),
    healthResult: values.get("health_result") ?? "",
    outcome: values.get("outcome") ?? "",
    rollbackTarget: parseOptionalImage("rollback", values.get("rollback_target") ?? ""),
  };
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "validate") {
      let deploymentId: string | undefined;
      let webImage: string | undefined;
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (flag === "--image") {
          webImage = parseImmutableImage(value).reference;
        } else if (flag === "--deployment-id") {
          if (value.length !== 36) throw new InvalidImageError("deployment id must be a uuid");
          deploymentId = value;
        } else {
          throw new InvalidImageError(`unknown flag ${flag ?? ""}`.trim());
        }
      }
      if (webImage === undefined) {
        throw new InvalidImageError("--image is required");
      }
      deploymentId ??= crypto.randomUUID();
      console.log(`deployment_id=${deploymentId}`);
      return;
    }
    if (command === "record") {
      const values = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        if (flag === undefined || !flag.startsWith("--")) {
          throw new Error(`expected a flag at argument ${index}`);
        }
        values.set(flag.slice(2), args[index + 1] ?? "");
      }
      const required = [
        "records-file",
        "deployment-id",
        "source-commit",
        "artifact-identity",
        "environment",
        "workflow-run",
        "started-at",
        "health-result",
        "outcome",
      ] as const;
      for (const key of required) {
        if (!values.has(key) || values.get(key) === "") {
          throw new Error(`--${key} is required`);
        }
      }
      if (values.get("environment") !== "staging") {
        throw new Error("only staging environment records can be written by an agent");
      }
      const outcome = values.get("outcome") as DeploymentOutcome;
      const previous = values.get("previous-digest") ?? "";
      const record: DeploymentRecord = {
        deployment_id: values.get("deployment-id") ?? "",
        source_commit: values.get("source-commit") ?? "",
        track: "cloud",
        artifact_identity: values.get("artifact-identity") ?? "",
        environment: "staging",
        workflow_run: values.get("workflow-run") ?? "",
        previous_digest: previous === "" ? null : previous,
        rollback_target: values.get("rollback-target") || null,
        health_result: values.get("health-result") ?? "",
        approval: null,
        executor: values.get("executor") || "agent",
        started_at: values.get("started-at") ?? "",
        completed_at: new Date().toISOString(),
        outcome,
      };
      if (!isIsoTimestamp(record.started_at)) {
        throw new Error("--started-at must be an ISO 8601 timestamp");
      }
      const line = renderAuditRecord(record);
      const file = values.get("records-file");
      if (file !== undefined && file !== "") {
        await Bun.write(file, line, { append: true });
      } else {
        console.error("refusing to write an audit record without --records-file");
        process.exitCode = 1;
        return;
      }
      console.log("recorded");
      return;
    }
    throw new Error(`unknown command: ${command ?? ""}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await run();
}
