/**
 * Pure helpers for the one-shot #general notice after Leader weekly-report send
 * (ADR 0011 slice 4). Channel posting stays behind a delivery port.
 */

const REQUEST_NAMESPACE = "c0fe12e0-a551-4111-b001-000000000001";

/** Stable UUID request_id so retries of the same parent notice do not double-post. */
export function weeklyAssignmentChannelRequestId(parentReportId: string): string {
  const nsHex = REQUEST_NAMESPACE.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const digest = new Bun.CryptoHasher("sha1")
    .update(nsBytes)
    .update(`weekly-assignment-channel:${parentReportId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildWeeklyAssignmentChannelBody(input: {
  senderDisplayName: string;
  week: number;
}): string {
  const name = input.senderDisplayName.trim() || "Leader";
  return `${name} 已布置 W${input.week} 周报，请到「我的周报」填写。`;
}
