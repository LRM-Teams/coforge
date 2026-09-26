import { isRecord } from "@lrm/coforge-sdk/internal";

/** Narrowing helpers for the loosely typed JSON records provider processes emit. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Joins the `text` blocks of a provider content array; a bare string is returned as is. */
export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string)
    .join("");
}

export function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
