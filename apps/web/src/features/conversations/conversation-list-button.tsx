import { createContext, useContext } from "react";
import { ArrowLeft } from "@untitledui/icons";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";

/** The conversation list's controls for the panes beside it. Its own module so a pending or empty
 * pane can show the back button without loading the directory, realtime and dialogs behind
 * `conversation-navigation`. */
export const ConversationListContext = createContext<{
  showList: () => void;
  /** Hides the list and reveals the detail pane. Called when a directory row is chosen, so a tap
   * opens the conversation even when the URL does not change (the row that is already current). */
  closeList: () => void;
  detailVisible: boolean;
} | null>(null);

export function ConversationListButton() {
  const navigation = useContext(ConversationListContext);
  if (!navigation) return null;
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      aria-label={m.conversation_back_to_list()}
      onClick={navigation.showList}
      className="-ml-2 shrink-0 lg:hidden"
    />
  );
}
