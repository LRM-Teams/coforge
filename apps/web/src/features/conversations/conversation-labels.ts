import { m } from "#src/paraglide/messages";

/** "1 reply" / "N replies", as the thread preview and the thread pane both count. */
export function replyCountLabel(count: number): string {
  return count === 1 ? m.conversation_thread_one_reply() : m.conversation_thread_replies({ count });
}
