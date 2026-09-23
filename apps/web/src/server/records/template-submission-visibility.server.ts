/** Submissions under a Leader weekly parent are listed only after the member sends. */
export function isVisibleTemplateSubmission(status: string): boolean {
  return status === "submitted" || status === "shared";
}
