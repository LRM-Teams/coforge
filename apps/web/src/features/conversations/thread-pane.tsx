import type { ComponentProps } from "react";

import { isAppError } from "#src/lib/app-error";
import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import { ConversationPane } from "./conversation-pane";
import type { DirectConversationView } from "./conversation-types";
import { ThreadLoadStatus, ThreadRootState, type ThreadRootLoad } from "./thread-root-state";
import { useConversationThread } from "./thread-queries";

type PaneProps = ComponentProps<typeof ConversationPane>;

/**
 * One thread's pane: its replies are read the first time it opens (the window carries only the
 * thread's summary), with the thread slot's own loading state until they arrive, and its retry if
 * the read fails. The pane itself mounts once the whole thread is there, so it opens on the first
 * unread reply (or the latest) as it always has. From then on the thread's Query keeps it live and
 * only this pane re-renders for a reply.
 */
export function ThreadPane({
  conversation,
  root,
  rootSlot,
  threadContext,
  onClose,
  ...pane
}: Omit<PaneProps, "conversation" | "root"> & {
  conversation: Omit<DirectConversationView, "agent" | "messages">;
  root: NonNullable<PaneProps["root"]>;
}) {
  const thread = useConversationThread(conversation.conversationId, root.id);
  if (!thread.data) {
    const load: ThreadRootLoad = thread.isError
      ? isAppError(thread.error) && thread.error.code === "NOT_FOUND"
        ? { status: "missing" }
        : { status: "failed", errorId: isAppError(thread.error) ? thread.error.errorId : undefined }
      : { status: "loading" };
    const retry = () => void thread.refetch();
    // The Task popup shows the Task itself in place of a header, and its thread below it.
    return rootSlot ? (
      <>
        {rootSlot}
        <ThreadLoadStatus load={load} onRetry={retry} />
      </>
    ) : (
      <ThreadRootState load={load} context={threadContext} onClose={onClose} onRetry={retry} />
    );
  }
  return (
    <>
      {/* The Tasks its replies name: the window's own read covers only its top-level messages. */}
      <ConversationTaskDemand
        conversationId={conversation.conversationId}
        messages={thread.data.replies}
        hasNewer={false}
        readWindow={false}
        openTaskNumber={undefined}
      />
      <ConversationPane
        {...pane}
        root={root}
        rootSlot={rootSlot}
        threadContext={threadContext}
        onClose={onClose}
        conversation={{ ...conversation, messages: thread.data.replies }}
      />
    </>
  );
}
