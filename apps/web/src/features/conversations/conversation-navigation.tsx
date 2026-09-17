import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getRouteApi, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PageHeader } from "@/components/layout/page-header";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { ConversationDirectory } from "./conversation-directory";
import { m } from "@/paraglide/messages";
import { cx } from "@/utils/cx";
import { createPublicChannel } from "./channels.functions";
import { useLiveAgents } from "./conversation-layout";
import { CreateChannelDialog } from "./create-channel-dialog";

const messagesRoute = getRouteApi("/_app/messages");
const ConversationListContext = createContext<{
  showList: () => void;
  detailVisible: boolean;
} | null>(null);

export function useConversationDetailVisible() {
  return useContext(ConversationListContext)?.detailVisible ?? true;
}

/** Keep both panels mounted so returning to the list preserves scroll and drafts. */
export function ConversationNavigation({ children }: { children: ReactNode }) {
  const { channels, projects } = messagesRoute.useLoaderData();
  const agents = useLiveAgents();
  const desktop = useBreakpoint("lg");
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [browsing, setBrowsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const create = useServerFn(createPublicChannel);
  const channel = useParams({ from: "/_app/messages/channels/$channelId", shouldThrow: false });
  const agent = useParams({ from: "/_app/messages/$agentId", shouldThrow: false });
  const showList = browsing || pathname === "/messages" || pathname === "/messages/";
  useEffect(() => router.subscribe("onResolved", () => setBrowsing(false)), [router]);

  return (
    <ConversationListContext
      value={{ showList: () => setBrowsing(true), detailVisible: desktop || !showList }}
    >
      <main className="flex h-svh min-w-0 flex-col bg-primary lg:flex-row">
        <section
          className={cx(
            "min-h-0 flex-1 flex-col lg:flex lg:w-72 lg:flex-none lg:border-r lg:border-secondary",
            showList ? "flex" : "hidden",
          )}
        >
          <PageHeader
            heading={m.navigation_chat()}
            actions={
              <Button size="sm" iconLeading={Plus} onPress={() => setCreating(true)}>
                {m.channel_create()}
              </Button>
            }
          />
          <div className="min-h-0 flex-1 overflow-y-auto py-4">
            <ConversationDirectory
              channels={channels}
              agents={agents}
              selectedChannelId={channel?.channelId}
              selectedAgentId={agent?.agentId}
            />
          </div>
        </section>
        <div
          className={cx("min-h-0 min-w-0 flex-1 flex-col lg:flex", showList ? "hidden" : "flex")}
        >
          {children}
        </div>
      </main>
      {creating && (
        <CreateChannelDialog
          open={creating}
          onOpenChange={setCreating}
          projects={projects}
          onCreate={async (name, projectId) => {
            const result = await create({ data: { name, projectId } });
            await router.invalidate({ sync: true });
            await router.navigate({
              to: "/messages/channels/$channelId",
              params: { channelId: result.id },
            });
          }}
        />
      )}
    </ConversationListContext>
  );
}

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
