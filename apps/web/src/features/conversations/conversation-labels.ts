import { m } from "#src/paraglide/messages";

/** "1 reply" / "N replies", as the thread preview and the thread pane both count. */
export function replyCountLabel(count: number): string {
  return count === 1 ? m.conversation_thread_one_reply() : m.conversation_thread_replies({ count });
}

/** A label with the viewer's unread count after it, when there is one. */
export function withUnreadCount(label: string, unread: number): string {
  return unread > 0 ? `${label} · ${m.conversation_thread_unread({ count: unread })}` : label;
}
