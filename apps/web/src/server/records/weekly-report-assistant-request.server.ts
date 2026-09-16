/**
 * Builds the User→weekly-report-assistant DM body. Keeps page context compact
 * and never embeds full report bodies.
 */
export function buildWeeklyReportAssistantRequestBody(input: {
  subjectType: "report" | "highlight" | "cycle";
  subjectId: string;
  userText: string;
  contextManifest: Record<string, unknown> | null;
}): string {
  const subjectKey = `${input.subjectType}:${input.subjectId}`;
  const manifest = input.contextManifest ?? {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  };
  return [
    "[weekly-report-context]",
    `subject: ${subjectKey}`,
    "manifest:",
    JSON.stringify(manifest),
    "[/weekly-report-context]",
    "",
    input.userText.trim(),
  ].join("\n");
}

export function weeklyReportAssistantSubjectFromBody(body: string): string | null {
  const match = body.match(/^\[weekly-report-context\]\nsubject:\s*(\S+)/m);
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
  subjectType: "report" | "highlight" | "cycle",
  subjectId: string,
): boolean {
  const subject = weeklyReportAssistantSubjectFromBody(body);
  if (!subject) return false;
  return subject === `${subjectType}:${subjectId}`;
}
