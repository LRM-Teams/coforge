import type { TaskView } from "@lrm/coforge-sdk/internal";

/**
 * The Task changes a collection has been told about that a read may not have seen yet: a read
 * whose snapshot was taken before a change answers after it, and must not put the older copy (or
 * a deleted Task) back. `over` is the collection's `select`: it lays each newer announced copy
 * over the row read, and drops a deleted Task. A copy leaves once a newer one is read; a deleted
 * Task never comes back, so its id stays (unless it is announced again: a Task converted again
 * from the message of a deleted one).
 */
export function createAnnouncedTasks() {
  const announced = new Map<string, TaskView>();
  const deleted = new Set<string>();
  return {
    over: <Row extends TaskView>(rows: readonly Row[]): Row[] =>
      rows.flatMap((row) => {
        if (deleted.has(row.messageId)) return [];
        const newer = announced.get(row.messageId);
        if (!newer) return [row];
        if (newer.revision >= row.revision) return [{ ...row, ...newer }];
        announced.delete(row.messageId);
        return [row];
      }),
    changed: (view: TaskView) => {
      announced.set(view.messageId, view);
      deleted.delete(view.messageId);
    },
    deleted: (messageId: string) => {
      announced.delete(messageId);
      deleted.add(messageId);
    },
  };
}
