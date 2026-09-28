/**
 * The shape the upload routes require of an uploaded file.
 *
 * Deliberately a duck type rather than `instanceof File`: `File` is per-realm, so a file that
 * crossed a boundary — a worker, or a runtime's own `File` constructor — fails the identity check
 * while still being exactly what the routes go on to read: `name`, `size` and `arrayBuffer`.
 *
 * Three copies of this shape lived in the upload routes (`api/attachments`, `api/me/avatar`, and
 * `api/agent/v1/attachments`, where it was named `isUploadFile`). `features/agents/agents.functions.ts`
 * checks `instanceof File` instead, in the browser realm, for the form state it validates; whether
 * those two should agree is a separate question, and it is left open here.
 */
export function isFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "arrayBuffer") === "function"
  );
}
