export type ConversationMessage = { id: string; sequence: number };

export function createConversationReconciler<T extends ConversationMessage>(
  initialSequence: number,
  loadPage: (afterSequence: number) => Promise<T[]>,
  mergePage: (messages: T[]) => void,
) {
  let cursor = initialSequence;
  let requested = false;
  let active: Promise<void> | undefined;

  const drain = async () => {
    do {
      requested = false;
      let page: T[];
      do {
        page = await loadPage(cursor);
        if (page.length) {
          cursor = Math.max(cursor, ...page.map((message) => message.sequence));
          mergePage(page);
        }
      } while (page.length === 100);
    } while (requested);
  };

  return {
    reconcile() {
      requested = true;
      active ??= drain().finally(() => {
        active = undefined;
      });
      return active;
    },
    advanceTo(sequence: number) {
      cursor = Math.max(cursor, sequence);
    },
  };
}
