import { stat } from "node:fs/promises";
import { MIME_TYPE_PATTERN } from "@lrm/coforge-sdk/internal";
import { CliError } from "./cli-error";

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

/** Explicit `--mime-type` wins; otherwise inferred by extension; otherwise a safe default. */
export function attachmentMimeType(path: string, explicitMimeType?: string): string {
  if (explicitMimeType) return explicitMimeType;
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return EXTENSION_MIME_TYPES[extension] ?? "application/octet-stream";
}

function invalidArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

/** Raft 1.0.32's code and message shape for a missing upload target (`resolveTargetAlias`). */
function missingTarget(): CliError {
  return new CliError({
    code: "MISSING_CHANNEL",
    message:
      "A target is required to attach the upload to. Pass --target '#name', '@user', or a thread target.",
    retryable: false,
  });
}

/** Validates `--mime-type`; a local precondition `CliError`, never a request. */
export function validateAttachmentMimeType(mimeType: string): void {
  if (!MIME_TYPE_PATTERN.test(mimeType))
    throw invalidArg(`--mime-type must look like type/subtype, got: ${mimeType}`);
}

/**
 * The `coforge attachment upload` preconditions that never issue a request, in Raft 1.0.32's
 * exact order (`src/commands/attachment/upload.ts`): `--path` presence, existence, regular-file,
 * non-empty, then `--target` presence (`MISSING_CHANNEL`, Raft's code for a missing upload
 * target), then `--mime-type` well-formedness. Returns the file's size for the caller's
 * subsequent server-capability size check (`GET .../attachments/capabilities`), which does issue
 * a request.
 */
export async function validateAttachmentUploadArgs(input: {
  path?: string;
  target?: string;
  mimeType?: string;
}): Promise<{ path: string; target: string; sizeBytes: number }> {
  if (!input.path) throw invalidArg("--path is required");
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(input.path);
  } catch {
    throw invalidArg(`--path does not exist: ${input.path}`);
  }
  if (!stats.isFile()) throw invalidArg(`--path is not a regular file: ${input.path}`);
  if (stats.size === 0) throw invalidArg("--path is empty; refusing to upload a 0-byte attachment");
  if (!input.target) throw missingTarget();
  if (input.mimeType !== undefined) validateAttachmentMimeType(input.mimeType);
  return { path: input.path, target: input.target, sizeBytes: stats.size };
}
