import { createContext, useContext, type ReactNode } from "react";

const ConversationIdContext = createContext<string | undefined>(undefined);

/**
 * The conversation whose messages render below: what a row's parts read their own data by — the
 * Task a message became, the Task a body references. The value changes only when the conversation
 * does, so rows never re-render through it.
 */
export function ConversationIdProvider({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  return (
    <ConversationIdContext.Provider value={conversationId}>
      {children}
    </ConversationIdContext.Provider>
  );
}

/** The conversation being shown; absent outside one (a search result, a Saved card). */
export function useConversationId() {
  return useContext(ConversationIdContext);
}
