import type { ReportContent } from "./records-content";

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
