const PLATFORM_TURN_OPEN = "[weekly-report-platform-turn]";
const PLATFORM_TURN_CLOSE = "[/weekly-report-platform-turn]";

/**
 * Builds the User→weekly-report-assistant DM body. Keeps page context compact
 * and never embeds full report bodies.
 *
 * `platformTurn` marks Collect-Run synthesizer wakes and similar handoffs that
 * must reach the Agent but must not appear as member-authored side-chat text.
 */
export function buildWeeklyReportAssistantRequestBody(input: {
  subjectType: "report" | "cycle";
  subjectId: string;
  /** Side-chat thread id (session scoped to the page subject). */
  sessionId?: string;
  userText: string;
  contextManifest: Record<string, unknown> | null;
  /** Hide this turn from the Records side panel while still waking the Agent. */
  platformTurn?: boolean;
}): string {
  const subjectKey = `${input.subjectType}:${input.subjectId}`;
  const manifest = input.contextManifest ?? {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  };
  const userText = input.userText.trim();
  const visibleText = input.platformTurn
    ? `${PLATFORM_TURN_OPEN}\n${userText}\n${PLATFORM_TURN_CLOSE}`
    : userText;
  return [
    "[weekly-report-context]",
    `subject: ${subjectKey}`,
    ...(input.sessionId ? [`session: ${input.sessionId}`] : []),
    "manifest:",
    JSON.stringify(manifest),
    "[/weekly-report-context]",
    "",
    visibleText,
  ].join("\n");
}

/** True when the DM is a platform handoff (collect→synthesize), not a User turn. */
export function isWeeklyReportPlatformTurn(body: string): boolean {
  const display = weeklyReportAssistantDisplayBody(body);
  if (display.startsWith(PLATFORM_TURN_OPEN) || body.includes(`\n${PLATFORM_TURN_OPEN}\n`)) {
    return true;
  }
  // Legacy wakes before the platform-turn marker existed.
  return display.startsWith("采集已全部结束。请根据老板周报模板结构");
}

export function weeklyReportAssistantSubjectFromBody(body: string): string | null {
  const match = body.match(/^\[weekly-report-context\][\s\S]*?\nsubject:\s*(\S+)/m);
  return match?.[1] ?? null;
}

export function weeklyReportAssistantSessionFromBody(body: string): string | null {
  const match = body.match(/^\[weekly-report-context\][\s\S]*?\nsession:\s*(\S+)/m);
  return match?.[1] ?? null;
}

export function weeklyReportAssistantDisplayBody(body: string): string {
  const marker = "[/weekly-report-context]";
  const index = body.indexOf(marker);
  if (index < 0) return body;
  return body.slice(index + marker.length).trim();
}

export function messageBelongsToWeeklyReportSubject(
  body: string,
  subjectType: "report" | "cycle",
  subjectId: string,
): boolean {
  const subject = weeklyReportAssistantSubjectFromBody(body);
  if (!subject) return false;
  return subject === `${subjectType}:${subjectId}`;
}
