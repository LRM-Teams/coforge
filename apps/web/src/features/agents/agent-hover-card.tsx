import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ChevronRight } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { HoverPopover, useClosePreview } from "#src/components/ui/hover-popover";
import { ClockTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import { StatusDot } from "#src/components/ui/status-dot";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { agentDisplay, isBusyTone, presentActivityRows } from "./agent-activity-presentation";
import { RECENT_ACTIVITY_LIMIT } from "./agent-activity";
import {
  agentProfileQuery,
  canManageAgent,
} from "#src/features/agents/profile-panel/agent-profile-queries";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { runtimeProviderLabel } from "./runtime-provider-display";
import type { ActivityEntry } from "./agent-activity";
import { useAgentRecentActivity, useLiveAgentDisplay } from "./workspace-agents-realtime";

const appRoute = getRouteApi("/w/$workspaceSlug");

/** The card's reads may be a few minutes old: live status comes from the realtime store, and a
 * profile edit invalidates the query itself. Re-hovering an Agent does not re-read its profile. */
const CARD_PROFILE_STALE_MS = 5 * 60_000;

/**
 * An Agent's avatar in a message stream. Hovering, focusing or long-pressing it peeks at the
 * Agent's card; pressing it opens the profile panel. `trigger` is the row's own avatar, which
 * subscribes to that Agent's live status itself, so a status change repaints only the avatar.
 */
export function AgentHoverCard({
  agentId,
  name,
  handle,
  src,
  trigger,
  onOpenProfile,
}: {
  agentId: string;
  /** The display name the message was sent under, shown until the card's profile read lands. */
  name: string;
  handle?: string;
  src?: string | null;
  trigger: ReactNode;
  onOpenProfile: OpenAgentProfile;
}) {
  return (
    <HoverPopover
      label={m.agent_open_profile({ name })}
      onPress={() => onOpenProfile(agentId)}
      triggerClassName="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
      className="w-70"
      trigger={trigger}
    >
      <AgentCard
        agentId={agentId}
        name={name}
        handle={handle}
        src={src}
        onOpenActivity={() => onOpenProfile(agentId, "activity")}
      />
    </HoverPopover>
  );
}

/** The card's content. React Aria mounts a popover's children only while it is open, so the
 * reads below run on a peek (and warm the profile panel), never per row. */
function AgentCard({
  agentId,
  name,
  handle,
  src,
  onOpenActivity,
}: {
  agentId: string;
  name: string;
  handle?: string;
  src?: string | null;
  onOpenActivity: () => void;
}) {
  const profile = useQuery({ ...agentProfileQuery(agentId), staleTime: CARD_PROFILE_STALE_MS });
  // Read here, beside the profile, so the two run side by side; the list itself shows only once
  // the profile says the viewer may see it.
  const activity = useAgentRecentActivity(agentId);
  const data = profile.data;
  // The live display once a publication has arrived; until then the profile read's own snapshot,
  // as the profile panel does.
  const display = useLiveAgentDisplay(agentId) ?? data?.display;
  const view = agentDisplay(display);
  const displayName = data?.displayName || name;
  const shownHandle = data?.name ?? handle;
  return (
    <>
      <div className="flex items-start gap-3 p-3">
        <Avatar
          size="md"
          alt=""
          src={data?.avatarUrl ?? src}
          initials={avatarInitial(displayName)}
          contentClassName={avatarToneClassName(displayName)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Heading slot="title" className="truncate text-sm font-semibold text-primary">
              {displayName}
            </Heading>
            {display && (
              <span className="flex min-w-0 items-center gap-1 text-xs text-tertiary">
                <StatusDot tone={view.tone} pulse={view.pulse} className="size-1.5 shrink-0" />
                <span className="truncate">{view.label}</span>
              </span>
            )}
          </div>
          {/* The handle only when it says something the name does not. */}
          {shownHandle && shownHandle !== displayName && (
            <p className="truncate font-mono text-xs text-tertiary">@{shownHandle}</p>
          )}
          {profile.isError ? (
            <p className="mt-2 border-t border-secondary pt-2 text-xs text-tertiary">
              {m.agent_card_unavailable()}
            </p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-secondary pt-2 font-mono text-xs">
              <CardFact label={m.agent_profile_computer()}>
                {data && (data.computer?.label || m.agent_profile_computer_unassigned())}
              </CardFact>
              <CardFact label={m.agent_runtime_field()}>
                {data && runtimeProviderLabel(data.runtimeConfig.runtime)}
              </CardFact>
              <CardFact label={m.agent_form_model()}>
                {data && (data.runtimeConfig.model || m.agent_form_provider_default())}
              </CardFact>
              <CardFact label={m.agent_form_reasoning()}>
                {data && (data.runtimeConfig.reasoning || m.agent_form_provider_default())}
              </CardFact>
            </dl>
          )}
        </div>
      </div>
      {data?.description && (
        <Tooltip title={data.description}>
          <TooltipTrigger className="block w-full truncate border-t border-secondary px-3 py-2 text-left text-xs text-tertiary outline-none">
            {data.description}
          </TooltipTrigger>
        </Tooltip>
      )}
      {/* The same viewers who get the profile panel's Activity tab. */}
      {data && canManageAgent(data) && (
        <CardRecentActivity activity={activity} onOpenActivity={onOpenActivity} />
      )}
    </>
  );
}

/** One label/value pair; a skeleton holds the value's line until the profile read lands. */
function CardFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-quaternary">{label}</dt>
      <dd className="min-w-0 truncate text-tertiary">
        {children ?? <Skeleton className="mt-0.5 h-3 w-20" />}
      </dd>
    </>
  );
}

/** The Agent's last few noteworthy events, read from the app shell's one Activity subscription.
 * Hidden while there is nothing to show. */
function CardRecentActivity({
  activity,
  onOpenActivity,
}: {
  activity: readonly ActivityEntry[];
  onOpenActivity: () => void;
}) {
  const timeZone = appRoute.useLoaderData({ select: (data) => data.timeZone });
  const closePreview = useClosePreview();
  // The recent-Activity cache is capped already; merging a statement's fragments into rows can
  // still leave more rows than the card shows. The cache is newest first; the card reads top to
  // bottom in time order, newest last.
  const rows = presentActivityRows(activity).slice(0, RECENT_ACTIVITY_LIMIT).reverse();
  if (!rows.length) return null;
  return (
    <div className="border-t border-secondary px-3 py-2">
      <Button
        color="link-gray"
        size="sm"
        iconTrailing={ChevronRight}
        className="mb-1.5 text-xs"
        onPress={() => {
          closePreview();
          onOpenActivity();
        }}
      >
        {m.agent_card_recent_activity()}
      </Button>
      <ol className="space-y-1.5">
        {rows.map((entry) => (
          <li key={entry.key} className="flex min-w-0 items-center gap-1.5 text-xs">
            <ClockTime
              value={new Date(entry.observedAtMs)}
              timeZone={timeZone}
              plain
              className="shrink-0 font-mono text-quaternary"
            />
            <StatusDot
              tone={entry.recentTone}
              pulse={isBusyTone(entry.recentTone)}
              className="size-1.5 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-tertiary">{entry.recentLabel}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
