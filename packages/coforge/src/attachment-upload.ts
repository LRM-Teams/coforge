import { stat } from "node:fs/promises";
import { CliError } from "./cli-error";

/** RFC 6838 `type/subtype`, case-insensitively; matches what the Agent HTTP route accepts. */
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

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

/** Validates `--mime-type`; a local precondition `CliError`, never a request. */
export function validateAttachmentMimeType(mimeType: string): void {
  if (!MIME_TYPE_PATTERN.test(mimeType)) throw invalidArg(`--mime-type is invalid: ${mimeType}`);
}

/**
 * The `coforge attachment upload` preconditions that never issue a request: presence of
 * `--path`/`--target`, that `--path` names an existing, non-empty regular file, and that an
 * explicit `--mime-type` is well-formed. Returns the file's size for the caller's subsequent
 * server-capability size check (`GET .../attachments/capabilities`), which does issue a request.
 */
export async function validateAttachmentUploadArgs(input: {
  path?: string;
  target?: string;
  mimeType?: string;
}): Promise<{ path: string; target: string; sizeBytes: number }> {
  if (!input.path) throw invalidArg("--path is required");
  if (!input.target) throw invalidArg("--target is required");
  if (input.mimeType !== undefined) validateAttachmentMimeType(input.mimeType);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(input.path);
  } catch {
    throw invalidArg(`--path does not exist: ${input.path}`);
  }
  if (!stats.isFile()) throw invalidArg(`--path is not a regular file: ${input.path}`);
  if (stats.size === 0) throw invalidArg("--path is empty; refusing to upload a 0-byte attachment");
  return { path: input.path, target: input.target, sizeBytes: stats.size };
}
