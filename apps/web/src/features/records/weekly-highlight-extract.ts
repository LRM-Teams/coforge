export type RecordAssistantPayload =
  | { kind: "offer-help-generate" }
  | { kind: "collect-plan"; reportId: string; year: number; week: number }
  | { kind: "collect-run"; runId: string }
  | {
      kind: "confirm-intent";
      intent: "collect-again" | "synthesize";
      reportId: string;
      year: number;
      week: number;
      /** Original user turn; forwarded into synthesizer wake on confirm. */
      userGuidance?: string;
    }
  | { kind: "intent-declined" }
  | {
      kind: "offer-send";
      year?: number;
      week?: number;
      /** e.g. `2026 W36 (08.31-09.04)` */
      weekTitle?: string;
      updatedAt?: string;
      recipients?: Array<{
        displayName: string;
        avatarUrl: string | null;
      }>;
      recipientTotal?: number;
    };

export function parseRecordAssistantPayload(value: unknown): RecordAssistantPayload | null {
  if (!value || typeof value !== "object") return null;
  const row = value as {
    kind?: unknown;
    reportId?: unknown;
    runId?: unknown;
    year?: unknown;
    week?: unknown;
    intent?: unknown;
    userGuidance?: unknown;
    weekTitle?: unknown;
    updatedAt?: unknown;
    recipients?: unknown;
    recipientTotal?: unknown;
  };
  if (row.kind === "offer-send") {
    const recipients = Array.isArray(row.recipients)
      ? row.recipients.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const person = entry as { displayName?: unknown; avatarUrl?: unknown };
          if (typeof person.displayName !== "string" || !person.displayName.trim()) return [];
          return [
            {
              displayName: person.displayName.trim(),
              avatarUrl: typeof person.avatarUrl === "string" ? person.avatarUrl : null,
            },
          ];
        })
      : undefined;
    return {
      kind: "offer-send",
      ...(typeof row.year === "number" ? { year: row.year } : {}),
      ...(typeof row.week === "number" ? { week: row.week } : {}),
      ...(typeof row.weekTitle === "string" && row.weekTitle.trim()
        ? { weekTitle: row.weekTitle.trim() }
        : {}),
      ...(typeof row.updatedAt === "string" && row.updatedAt.trim()
        ? { updatedAt: row.updatedAt.trim() }
        : {}),
      ...(recipients && recipients.length > 0 ? { recipients } : {}),
      ...(typeof row.recipientTotal === "number" && Number.isInteger(row.recipientTotal)
        ? { recipientTotal: row.recipientTotal }
        : {}),
    };
  }
  if (row.kind === "offer-help-generate") return { kind: "offer-help-generate" };
  if (row.kind === "intent-declined") return { kind: "intent-declined" };
  if (
    row.kind === "confirm-intent" &&
    (row.intent === "collect-again" || row.intent === "synthesize") &&
    typeof row.reportId === "string" &&
    typeof row.year === "number" &&
    typeof row.week === "number"
  ) {
    return {
      kind: "confirm-intent",
      intent: row.intent,
      reportId: row.reportId,
      year: row.year,
      week: row.week,
      ...(typeof row.userGuidance === "string" && row.userGuidance.trim()
        ? { userGuidance: row.userGuidance.trim() }
        : {}),
    };
  }
  if (
    row.kind === "collect-plan" &&
    typeof row.reportId === "string" &&
    typeof row.year === "number" &&
    typeof row.week === "number"
  ) {
    return {
      kind: "collect-plan",
      reportId: row.reportId,
      year: row.year,
      week: row.week,
    };
  }
  if (row.kind === "collect-run" && typeof row.runId === "string") {
    return { kind: "collect-run", runId: row.runId };
  }
  return null;
}

/** Member accepts the assignee-side “help me generate” offer (E1 → E2). */
export function looksLikeMemberGenerateOfferAccept(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (/^(需要|好的|好|帮我生成|直接生成|需要帮忙)[!！。.?？]*$/i.test(text)) return true;
  return /需要.*(生成|帮忙)|帮我.*(生成|写周报)|直接生成/i.test(text);
}

/** User asks to open / re-open the Collect plan card (ADR 0032 E2). */
export function looksLikeCollectAgainRequest(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (
    /^(再采集|重新采集|再采一次|再采集一遍|重新采一遍|再跑一遍采集|再扫一遍)[!！。.?？]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /(再|重新|再来|再跑).{0,6}(采集|收集)|collect\s*(again|once more)|re-?collect/i.test(text);
}

/** User asks to synthesize the member report from ready collect packs. */
export function looksLikeSynthesizeWeeklyReportRequest(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (
    /^(整理周报|总结周报|生成周报|写周报|整理一下|总结一下|再整理一遍|重新整理)[!！。.?？]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /(整理|总结|合成).{0,6}周报|(根据|基于).{0,12}(采集包|证据|采集).{0,12}(整理|总结|写|生成)|synthesize|summarize.*(report|week)/i.test(
    text,
  );
}

/** User asks to (re)organize overview team key points in side chat. */
export function looksLikeTeamKeyPointReorganizeRequest(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (
    /^(重新整理|再整理一次|再整理一遍|整理全员要点|整理全员周报|整理要点|重新提炼|再提炼一次|(帮我)?整理(一下)?全员(周报|要点))[!！。.?？]*$/i.test(
      text,
    )
  ) {
    return true;
  }
  return /(重新|再).{0,4}(整理|提炼).{0,8}(要点|全员)?|(整理|提炼).{0,8}全员.{0,4}(要点|周报)|帮我.{0,10}(整理|提炼).{0,10}(全员|要点)/i.test(
    text,
  );
}

/** Platform rule path for member report side chat (skip Agent LLM). */
export function looksLikeMemberReportRuleIntent(body: string): boolean {
  return (
    looksLikeMemberGenerateOfferAccept(body) ||
    looksLikeCollectAgainRequest(body) ||
    looksLikeSynthesizeWeeklyReportRequest(body)
  );
}

export type RecordSideChatSurface = "format" | "member-leader" | "member-assignee" | "plain";

/**
 * Collect/synthesize short-phrases only belong on the member-assignee surface.
 * On overview (`plain`) or template (`format`), the same text (e.g. 「重新整理」)
 * must reach the Agent DM instead of being swallowed as a no-op RecordComment.
 */
export function shouldUseMemberReportRulePath(
  surface: RecordSideChatSurface,
  body: string,
): boolean {
  return surface === "member-assignee" && looksLikeMemberReportRuleIntent(body);
}
