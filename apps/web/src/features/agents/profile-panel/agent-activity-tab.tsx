import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Skeleton } from "#src/components/ui/skeleton";
import {
  agentDiagnosticInfo,
  type AgentDiagnosticFacts,
} from "#src/features/agents/agent-diagnostics";
import { AgentActivityTimeline } from "#src/features/agents/agent-activity-timeline";
import { useAgentActivityFeed } from "#src/features/agents/workspace-agents-realtime";
import { copyText } from "#src/features/records/report-editor/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";
import { PanelMessage } from "./panel-message";

/** The profile panel's Activity tab: a diagnostics band with a copy button over the log. */
export function AgentActivityTab({
  agent,
  display,
  timeZone,
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
  timeZone: string | null;
}) {
  const feed = useAgentActivityFeed(agent.id);
  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-secondary py-1 pr-3.5 pl-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_activity_diagnostics()}</p>
        <CopyDiagnosticsButton
          text={() =>
            agentDiagnosticInfo({
              agent,
              display,
              // The feed is newest first.
              lastActivityAtMs: feed.data?.[0]?.observedAtMs,
            })
          }
        />
      </div>
      <div className="min-h-0 flex-1">
        {feed.data ? (
          <AgentActivityTimeline activity={feed.data} timeZone={timeZone} />
        ) : feed.isError && !feed.isFetching ? (
          <PanelMessage text={m.agent_activity_error()} alert onRetry={() => void feed.refetch()} />
        ) : (
          <div aria-busy="true" className="flex flex-col gap-3 px-4 py-4">
            <p role="status" className="sr-only">
              {m.agent_activity_loading()}
            </p>
            {["w-2/5", "w-3/5", "w-1/2", "w-3/4"].map((width) => (
              <div key={width} className="flex gap-2">
                <Skeleton className="h-4 w-16 shrink-0" />
                <Skeleton className={`h-4 ${width}`} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Copies the diagnostic block; the icon turns into a check for a moment to confirm it. */
function CopyDiagnosticsButton({ text }: { text: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ButtonUtility
      icon={copied ? Check : Copy}
      size="sm"
      color="tertiary"
      tooltip={copied ? m.agent_activity_diagnostics_copied() : m.agent_activity_copy_diagnostics()}
      aria-label={m.agent_activity_copy_diagnostics()}
      onClick={() => {
        void copyText(text()).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    />
  );
}
