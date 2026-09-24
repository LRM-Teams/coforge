import { Button as AriaButton } from "react-aria-components";
import {
  ArrowLeft,
  Bell01 as Bell,
  BellOff01 as BellOff,
  DotsVertical,
  MarkerPin01,
  XClose,
} from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { m } from "#src/paraglide/messages";

/** The viewer's follow state for a thread, where following is offered. */
export type ThreadFollow = { followed: boolean; onChange: (followed: boolean) => void };

/**
 * The thread pane's header: the title names the thread and where it lives and scrolls back to
 * the root; the pane's actions sit behind one menu, then Close. Below `md` the pane covers the
 * chat, so a back arrow leads and Close steps aside for it.
 */
export function ThreadPaneHeader({
  context,
  onScrollToTop,
  onClose,
  onViewInConversation,
  follow,
  action,
}: {
  /** Where the thread lives, named after "Thread": `#channel` or `@name`. */
  context?: string;
  /** Scrolls back to the root; absent while the thread has no messages to scroll through. */
  onScrollToTop?: () => void;
  onClose?: () => void;
  onViewInConversation?: () => void;
  follow?: ThreadFollow;
  /** Shown before the actions menu (the Agents following the thread). */
  action?: React.ReactNode;
}) {
  const title = (
    <>
      {m.conversation_thread()}
      {context && (
        <span className="font-normal text-tertiary">
          {m.conversation_thread_title_context({ name: context })}
        </span>
      )}
    </>
  );
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-4 md:px-6">
      {/* The -ml-1.5 cancels the button's p-1.5 so the arrow glyph itself lands on the pane
          gutter (docs/design/page-skeleton-and-density.md §8 optical alignment). */}
      <ButtonUtility
        icon={ArrowLeft}
        size="sm"
        color="tertiary"
        className="-ml-1.5 md:hidden"
        onClick={onClose}
        aria-label={m.conversation_thread_back()}
      />
      <h2 className="flex min-w-0 flex-1 text-base font-semibold">
        {onScrollToTop ? (
          <Tooltip title={m.conversation_thread_scroll_to_top()} placement="bottom start">
            <AriaButton
              onPress={onScrollToTop}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {title}
            </AriaButton>
          </Tooltip>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
      </h2>
      <div className="-mr-1.5 flex shrink-0 items-center gap-1">
        {action}
        {(onViewInConversation || follow) && (
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsVertical}
              size="sm"
              color="tertiary"
              tooltip={m.conversation_thread_actions()}
            />
            <Dropdown.Popover placement="bottom end" className="w-52">
              <Dropdown.Menu aria-label={m.conversation_thread_actions()}>
                {onViewInConversation && (
                  <Dropdown.Item
                    id="view-in-conversation"
                    icon={MarkerPin01}
                    label={m.conversation_thread_view_in_channel()}
                    onAction={onViewInConversation}
                  />
                )}
                {follow && (
                  <Dropdown.Item
                    id="follow"
                    icon={follow.followed ? BellOff : Bell}
                    label={
                      follow.followed
                        ? m.conversation_thread_unfollow()
                        : m.conversation_thread_follow()
                    }
                    onAction={() => follow.onChange(!follow.followed)}
                  />
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        )}
        <ButtonUtility
          icon={XClose}
          size="sm"
          color="tertiary"
          className="hidden md:inline-flex"
          tooltip={m.conversation_thread_close()}
          onClick={onClose}
        />
      </div>
    </header>
  );
}
