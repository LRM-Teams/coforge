import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { ConversationListButton } from "./conversation-list-button";

/**
 * The loading screen Chat shows until its lists and the open conversation have been read in the
 * browser: the frame `ConversationNavigation` draws (the list column from a desktop width, the
 * conversation beside it), with skeletons where the rows will be. It is also what the server
 * sends for a Chat page.
 */
export function MessagesPending() {
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary lg:flex-row">
      <section className="hidden min-h-0 flex-col lg:flex lg:w-72 lg:flex-none lg:border-r lg:border-secondary">
        <PageHeader heading={m.navigation_chat()} />
        <div
          aria-hidden="true"
          className="min-h-0 flex-1 space-y-6 overflow-hidden px-6 py-4 motion-safe:animate-pulse"
        >
          {[
            ["w-24", "w-32", "w-20", "w-28"],
            ["w-28", "w-24", "w-32"],
          ].map((widths, group) => (
            <div key={group} className="space-y-3">
              <Skeleton className="h-2.5 w-16" />
              {widths.map((width) => (
                <div key={width} className="flex items-center gap-3">
                  <Skeleton className="size-5 shrink-0" />
                  <Skeleton className={`h-3 ${width}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConversationPending />
      </div>
    </main>
  );
}

export function ConversationPending() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 md:px-6">
        <ConversationListButton />
        <p role="status" className="sr-only">
          {m.conversation_loading()}
        </p>
      </header>
      <div
        aria-busy="true"
        aria-label={m.conversation_history()}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {/* The same reading column as the loaded stream, so rows do not jump sideways on load. */}
        <div
          aria-hidden="true"
          className={`${MESSAGE_COLUMN_CLASS} space-y-8 p-4 motion-safe:animate-pulse md:p-6`}
        >
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <div key={width} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2.5 pt-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={`h-3 ${width}`} />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* The composer's frame, in the same column as the stream above. */}
      <div className={MESSAGE_COLUMN_CLASS}>
        <div
          aria-hidden="true"
          className="mx-4 mt-2 mb-3 h-16 shrink-0 rounded-xl border border-primary md:mx-6"
        />
      </div>
    </div>
  );
}
