import { useState } from "react";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Hash01, RefreshCcw01 } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import {
  SaveErrorMessage,
  saveErrorFrom,
  SettingsGroup,
  type SaveError,
} from "#src/components/settings-content";
import { isAppError } from "#src/lib/app-error";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { loadArchivedChannels, setPublicChannelArchived } from "./channels.functions";
import { useRefreshSidebarChannels } from "./sidebar-lists";

type ArchivedChannels = Awaited<ReturnType<typeof loadArchivedChannels>>;
type ArchivedChannel = NonNullable<ArchivedChannels>[number];

/** The sentence for a failed unarchive, by what the server answered. */
function unarchiveError(cause: unknown, name: string): string {
  return isAppError(cause) && cause.code === "ACCESS_DENIED"
    ? m.settings_archived_channels_unarchive_denied()
    : m.settings_archived_channels_unarchive_error({ name });
}

/**
 * Settings → Workspace profile → Archived channels: every archived channel, for a Workspace owner
 * or admin to open or unarchive. Absent (no empty state) when there is none or the viewer may not
 * unarchive them. One unarchive runs at a time; a failure stays above the list, and stays even
 * when the reload after a refusal leaves no rows.
 */
export function ArchivedChannelsGroup({
  channels,
  timeZone,
}: {
  channels: ArchivedChannels;
  timeZone: string | null;
}) {
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const [error, setError] = useState<SaveError | null>(null);
  const setArchived = useServerFn(setPublicChannelArchived);
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const rows = channels ?? [];

  async function unarchive(channel: ArchivedChannel) {
    setUnarchivingId(channel.id);
    setError(null);
    try {
      try {
        await setArchived({ data: { channelId: channel.id, archived: false } });
      } catch (cause) {
        const code = isAppError(cause) ? cause.code : undefined;
        // A deleted channel needs no sentence.
        if (code !== "NOT_FOUND")
          setError(saveErrorFrom(unarchiveError(cause, channel.name), cause));
        // Deleted meanwhile, or the viewer is no longer an owner or admin: reload so rows that
        // can no longer be unarchived here go. Any other failure changed nothing.
        if (code !== "NOT_FOUND" && code !== "ACCESS_DENIED") return;
      }
      // Past the write's catch, so a failed reload never reads as a failed unarchive. Every
      // sidebar follows: this one here, the others through the write's realtime signal.
      void refreshSidebarChannels();
      await router.invalidate({ sync: true });
    } finally {
      setUnarchivingId(null);
    }
  }

  if (rows.length === 0 && !error) return null;

  return (
    <SettingsGroup
      icon={Archive}
      label={m.settings_archived_channels()}
      badge={
        rows.length > 0 && (
          <Badge type="pill-color" color="gray" size="sm">
            {rows.length}
          </Badge>
        )
      }
    >
      {error && <SaveErrorMessage error={error} />}
      {rows.length > 0 && (
        <ul className="divide-y divide-secondary rounded-xl border border-secondary bg-primary shadow-xs">
          {rows.map((channel) => (
            <ArchivedChannelRow
              key={channel.id}
              channel={channel}
              workspaceSlug={workspaceSlug}
              timeZone={timeZone}
              unarchiving={unarchivingId === channel.id}
              disabled={unarchivingId !== null}
              onUnarchive={() => void unarchive(channel)}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function ArchivedChannelRow({
  channel,
  workspaceSlug,
  timeZone,
  unarchiving,
  disabled,
  onUnarchive,
}: {
  channel: ArchivedChannel;
  workspaceSlug: string;
  timeZone: string | null;
  unarchiving: boolean;
  disabled: boolean;
  onUnarchive: () => void;
}) {
  // Locale, zone and hour cycle are only known in the browser, so the date waits for hydration.
  const hydrated = useHydrated();
  const timeFormat = useTimeFormat();

  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* The line under the name says it is a public channel; the icon only echoes it. */}
        <span aria-hidden="true" className="shrink-0">
          <FeaturedIcon icon={Hash01} color="gray" theme="modern" size="sm" />
        </span>
        <div className="min-w-0">
          <Link
            to="/w/$workspaceSlug/channel/$channelId"
            params={{ workspaceSlug, channelId: channel.id }}
            aria-label={m.settings_archived_channels_open({ name: channel.name })}
            className="block truncate rounded-xs text-sm font-semibold text-primary underline underline-offset-2 outline-focus-ring hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            #{channel.name}
          </Link>
          <p className="text-sm text-tertiary">
            {m.settings_archived_channels_public()}
            {hydrated && (
              <>
                {" · "}
                <time dateTime={channel.archivedAt.toISOString()}>
                  {m.settings_archived_channels_archived_at({
                    time: formatDateForDisplay(
                      channel.archivedAt,
                      timeZone,
                      getLocale(),
                      timeFormat,
                    ),
                  })}
                </time>
              </>
            )}
          </p>
        </div>
      </div>
      <Button
        color="secondary"
        size="sm"
        iconLeading={RefreshCcw01}
        className="w-full sm:w-auto"
        // While it runs, the visible "Unarchiving…" is the button's name.
        aria-label={
          unarchiving
            ? undefined
            : m.settings_archived_channels_unarchive_label({ name: channel.name })
        }
        isDisabled={disabled}
        isLoading={unarchiving}
        showTextWhileLoading
        onPress={onUnarchive}
      >
        {unarchiving ? m.channel_settings_unarchiving() : m.channel_archived_unarchive()}
      </Button>
    </li>
  );
}
