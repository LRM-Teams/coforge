import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";

const RECORDS_RETURN_PATH = /^\/w\/([^/]+)\/records\//;

/** Only allow in-app Records return paths (`/w/<slug>/records/…`; no open redirect). */
export function sanitizeRecordsReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const slug = RECORDS_RETURN_PATH.exec(value)?.[1];
  if (!slug || !isValidWorkspaceSlug(slug)) return undefined;
  if (value.includes("://") || value.includes("\\") || value.includes("\n")) return undefined;
  // Block path traversal that would leave Records (`/w/<slug>/records/../..`).
  if (value.includes("/../") || value.endsWith("/..")) return undefined;
  if (value.length > 200) return undefined;
  return value;
}
