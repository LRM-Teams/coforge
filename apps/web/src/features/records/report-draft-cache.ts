import type { ReportContent } from "./records-content";
import { normalizeReportContent } from "./records-content";

/** In-session drafts so switching records does not revive stale loader bodies. */
const drafts = new Map<string, ReportContent>();
const pendingSaves = new Map<string, Promise<void>>();

export function readReportDraft(reportId: string): ReportContent | undefined {
  return drafts.get(reportId);
}

export function writeReportDraft(reportId: string, content: ReportContent) {
  drafts.set(reportId, content);
}

export function clearReportDraft(reportId: string) {
  drafts.delete(reportId);
}

export function trackReportSave(reportId: string, save: Promise<unknown>) {
  const tracked = save.then(
    () => undefined,
    () => undefined,
  );
  const wrapped = tracked.finally(() => {
    if (pendingSaves.get(reportId) === wrapped) pendingSaves.delete(reportId);
  });
  pendingSaves.set(reportId, wrapped);
  return wrapped;
}

export function waitForReportSave(reportId: string): Promise<void> | undefined {
  return pendingSaves.get(reportId);
}

/** Total markdown length across tabs — used to detect empty local drafts. */
export function reportBodyCharacterCount(content: ReportContent): number {
  const normalized = normalizeReportContent(content);
  let total = 0;
  for (const tab of Object.values(normalized.tabs ?? {})) {
    total += tab.markdown.length;
  }
  if (normalized.markdown) total += normalized.markdown.length;
  return total;
}

/**
 * After an assistant Confirm write (or other server-side body update), the
 * in-session draft may still be empty while PostgreSQL already has the body.
 * Prefer the server body in that case so the editor does not keep showing blank
 * and so a later autosave does not wipe the confirmed write.
 */
export function resolveReportEditorContent(input: {
  serverContent: unknown;
  draft: ReportContent | undefined;
}): ReportContent {
  const server = normalizeReportContent(input.serverContent);
  if (!input.draft) return server;
  const draft = normalizeReportContent(input.draft);
  if (reportBodyCharacterCount(draft) === 0 && reportBodyCharacterCount(server) > 0) {
    return server;
  }
  return draft;
}
