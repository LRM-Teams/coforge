import { hasErrorCode } from "@lrm/coforge-sdk/internal";

/**
 * Whether a Prisma write failed on a unique constraint (`P2002`). Callers turn it into their own
 * conflict answer. The check reads only the error code, so a test double that throws an error
 * carrying `code: "P2002"` matches the same way a real Prisma error does.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasErrorCode(error, "P2002");
}
