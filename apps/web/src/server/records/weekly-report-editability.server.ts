/** Only the author may change weekly-report body; Leader review of a sent assignment is read-only. */
export function canEditWeeklyReportContent(input: {
  viewerUserId: string;
  authorUserId: string;
}): boolean {
  return input.viewerUserId === input.authorUserId;
}
