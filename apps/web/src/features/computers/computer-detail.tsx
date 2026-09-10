import { useRef, useState } from "react";
import { Edit01 as Pencil, RefreshCw01 as RotateCw } from "@untitledui/icons";
import type { RuntimeProvider } from "@coforge/protocol";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Badge } from "@/components/base/badges/badges";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { RelativeTime } from "@/components/ui/relative-time";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";
import { computerLabel, operatingSystemLabel, type ComputerIdentity } from "./computer-identity";
import { ComputerTile } from "./computer-tile";
import { RuntimeIdentity, RuntimeUsage, type UsageView } from "./runtime-usage";
import type { ComputerRestartStatus } from "./computer.schemas";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_POLLS = 31;

export type ComputerDetailView = ComputerIdentity & {
  id: string;
  ownedByCurrentUser: boolean;
  online: boolean;
  connectedAt: Date | string;
  computerVersion?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  creator?: { displayName: string | null; username: string; avatarUrl: string | null };
  runtimes: {
    id: string;
    provider: RuntimeProvider;
    version: string;
    displayName: string;
    isPublic: boolean;
  }[];
  usage?: Record<string, UsageView>;
};

/**
 * One Computer's detail panel: what this machine is, which Code Agents it
 * carries, and the usage scan each of them answers.
 */
export function ComputerDetail({
  computer,
  timeZone = null,
  onScanUsage,
  onSetRuntimePublic,
  onUpdateDisplayName,
  onRestart,
  onReadRestartStatus,
  restartPollIntervalMs = RESTART_POLL_INTERVAL_MS,
  restartMaxPolls = RESTART_MAX_POLLS,
}: {
  computer: ComputerDetailView;
  timeZone?: string | null;
  onScanUsage: (provider: RuntimeProvider) => Promise<void>;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
  onUpdateDisplayName?: (displayName: string) => Promise<void>;
  onRestart?: (requestId: string) => Promise<ComputerRestartStatus>;
  onReadRestartStatus?: (requestId: string) => Promise<ComputerRestartStatus>;
  restartPollIntervalMs?: number;
  restartMaxPolls?: number;
}) {
  const [updatingRuntimeIdsState, setUpdatingRuntimeIdsState] = useState(() => new Set<string>());
  const updatingRuntimeIds = useRef(new Set<string>());
  const [runtimeVisibilityErrorIds, setRuntimeVisibilityErrorIds] = useState(
    () => new Set<string>(),
  );
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(false);
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const [restartResult, setRestartResult] = useState<ComputerRestartStatus>();
  const setRuntimePublic = async (runtimeId: string, isPublic: boolean) => {
    if (updatingRuntimeIds.current.has(runtimeId)) return;
    updatingRuntimeIds.current.add(runtimeId);
    setUpdatingRuntimeIdsState((current) => new Set(current).add(runtimeId));
    setRuntimeVisibilityErrorIds((current) => {
      const next = new Set(current);
      next.delete(runtimeId);
      return next;
    });
    try {
      await onSetRuntimePublic(runtimeId, isPublic);
    } catch {
      setRuntimeVisibilityErrorIds((current) => new Set(current).add(runtimeId));
    } finally {
      updatingRuntimeIds.current.delete(runtimeId);
      setUpdatingRuntimeIdsState((current) => {
        const next = new Set(current);
        next.delete(runtimeId);
        return next;
      });
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-secondary px-4 py-3 sm:px-6">
        <BackToComputers />
        <ComputerTile computer={computer} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-primary">
              {computerLabel(computer)}
            </h1>
            <Badge color={computer.online ? "success" : "gray"} size="sm">
              {computer.online ? m.computer_status_online() : m.computer_status_offline()}
            </Badge>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-tertiary">
            <span>{operatingSystemLabel(computer)}</span>
            <span aria-hidden="true">·</span>
            <span>{computerVersionLabel(computer)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {m.computer_connected_at()}{" "}
              <RelativeTime value={computer.connectedAt} timeZone={timeZone} plain />
            </span>
          </p>
        </div>
        {onRestart && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="md"
              color="secondary"
              iconLeading={RotateCw}
              isDisabled={restartState === "pending" || restartState === "accepted"}
              onPress={() => {
                setRestartState("pending");
                const requestId = crypto.randomUUID();
                void onRestart(requestId)
                  .then(async (initial) => {
                    setRestartResult(initial);
                    if (initial.status !== "accepted" || !onReadRestartStatus) return initial;
                    setRestartState("accepted");
                    for (let poll = 0; poll < restartMaxPolls; poll += 1) {
                      await new Promise((resolve) =>
                        window.setTimeout(resolve, restartPollIntervalMs),
                      );
                      const result = await onReadRestartStatus(requestId);
                      setRestartResult(result);
                      if (result.status !== "accepted") return result;
                    }
                    return { requestId, status: "failed" as const, reason: "timeout" as const };
                  })
                  .then(
                    (result) =>
                      setRestartState(
                        result.status === "completed"
                          ? "completed"
                          : result.status === "accepted"
                            ? "accepted"
                            : "error",
                      ),
                    () => setRestartState("error"),
                  );
              }}
            >
              {restartState === "pending"
                ? m.computer_restart_requesting()
                : m.computer_restart_action()}
            </Button>
          </div>
        )}
      </div>

      <div className="@container min-h-0 flex-1 space-y-8 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {restartState === "accepted" && (
          <p
            role="status"
            className="rounded-lg border border-secondary bg-success-primary p-3 text-sm text-success-primary"
          >
            {m.computer_restart_accepted()}
          </p>
        )}
        {restartState === "completed" && restartResult?.status === "completed" && (
          <p
            role="status"
            className="rounded-lg border border-secondary bg-success-primary p-3 text-sm text-success-primary"
          >
            {m.computer_restart_completed({
              version: restartResult.daemonVersion,
              process: restartResult.workerInstanceId,
            })}
          </p>
        )}
        {restartState === "error" && (
          <p
            role="alert"
            className="rounded-lg border border-error_subtle bg-error-primary p-3 text-sm text-error-primary"
          >
            {m.computer_restart_error()}
          </p>
        )}
        <section aria-labelledby="computer-overview">
          <h2 id="computer-overview" className="text-lg font-semibold tracking-tight">
            {m.computer_overview()}
          </h2>
          <dl className="mt-4 grid gap-x-8 gap-y-6 border-t border-secondary pt-6 md:grid-cols-2 xl:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-sm text-tertiary">{m.computer_display_name()}</dt>
              <dd className="mt-1 text-sm font-medium text-primary">
                {editingDisplayName ? (
                  <form
                    className="max-w-sm"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!onUpdateDisplayName) return;
                      setSavingDisplayName(true);
                      setDisplayNameError(false);
                      try {
                        await onUpdateDisplayName(displayNameDraft);
                        setEditingDisplayName(false);
                      } catch {
                        setDisplayNameError(true);
                      } finally {
                        setSavingDisplayName(false);
                      }
                    }}
                  >
                    <label className="sr-only" htmlFor={`display-name-${computer.id}`}>
                      {m.computer_display_name()}
                    </label>
                    <input
                      id={`display-name-${computer.id}`}
                      autoFocus
                      required
                      maxLength={200}
                      value={displayNameDraft}
                      disabled={savingDisplayName}
                      onChange={(event) => setDisplayNameDraft(event.currentTarget.value)}
                      className="h-9 w-full rounded-md border border-secondary bg-primary px-3 outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/50"
                    />
                    <div className="mt-2 flex gap-2">
                      <Button type="submit" size="sm" isDisabled={savingDisplayName}>
                        {savingDisplayName
                          ? m.computer_display_name_saving()
                          : m.computer_display_name_save()}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        color="secondary"
                        isDisabled={savingDisplayName}
                        onPress={() => {
                          setDisplayNameDraft(computer.displayName);
                          setDisplayNameError(false);
                          setEditingDisplayName(false);
                        }}
                      >
                        {m.computer_display_name_cancel()}
                      </Button>
                    </div>
                    {displayNameError && (
                      <p role="alert" className="mt-2 text-sm text-error-primary">
                        {m.computer_display_name_error()}
                      </p>
                    )}
                  </form>
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="break-words [overflow-wrap:anywhere]">
                      {computer.displayName}
                    </span>
                    {computer.ownedByCurrentUser && onUpdateDisplayName && (
                      <ButtonUtility
                        type="button"
                        size="sm"
                        color="tertiary"
                        icon={Pencil}
                        aria-label={m.computer_display_name_edit()}
                        onClick={() => {
                          setDisplayNameDraft(computer.displayName);
                          setDisplayNameError(false);
                          setEditingDisplayName(true);
                        }}
                      />
                    )}
                  </span>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-tertiary">{m.computer_hostname()}</dt>
              <dd className="mt-1 font-mono text-sm font-medium break-words text-primary [overflow-wrap:anywhere]">
                {computer.name}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-tertiary">{m.computer_added_by()}</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2 text-sm font-medium text-primary">
                {computer.creator ? (
                  <>
                    <Avatar
                      size="xs"
                      src={computer.creator.avatarUrl}
                      alt={computer.creator.displayName || computer.creator.username}
                      initials={avatarInitial(
                        computer.creator.displayName || computer.creator.username,
                      )}
                      contentClassName={avatarToneClassName(
                        computer.creator.displayName || computer.creator.username,
                      )}
                    />
                    <span className="truncate">
                      {computer.creator.displayName || computer.creator.username}
                    </span>
                  </>
                ) : (
                  m.computer_metadata_unknown()
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="computer-code-agents">
          <h2 id="computer-code-agents" className="text-lg font-semibold tracking-tight">
            {m.computer_code_agents()}
          </h2>
          {computer.runtimes.length ? (
            <ul className="mt-4 divide-y divide-secondary overflow-hidden rounded-xl border border-secondary shadow-xs">
              {computer.runtimes.map((runtime) => (
                <li
                  key={runtime.provider}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-4 p-4 text-sm @lg:px-5"
                >
                  {computer.ownedByCurrentUser ? (
                    <RuntimeUsage
                      runtime={runtime}
                      usage={computer.usage?.[runtime.provider]}
                      timeZone={timeZone}
                      onScan={() => onScanUsage(runtime.provider)}
                    />
                  ) : (
                    <RuntimeIdentity runtime={runtime} />
                  )}
                  {computer.ownedByCurrentUser && (
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        color="secondary"
                        aria-pressed={runtime.isPublic}
                        aria-label={
                          runtime.isPublic
                            ? m.computer_runtime_make_private_label({
                                runtime: runtime.displayName,
                              })
                            : m.computer_runtime_publish_label({
                                runtime: runtime.displayName,
                              })
                        }
                        isDisabled={updatingRuntimeIdsState.has(runtime.id)}
                        onPress={() => void setRuntimePublic(runtime.id, !runtime.isPublic)}
                      >
                        {runtime.isPublic
                          ? m.computer_runtime_public()
                          : m.computer_runtime_private()}
                      </Button>
                    </div>
                  )}
                  {computer.ownedByCurrentUser && runtimeVisibilityErrorIds.has(runtime.id) && (
                    <p role="alert" className="basis-full text-xs text-error-primary">
                      {m.computer_runtime_visibility_error()}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-xl border border-dashed border-secondary p-6 text-center text-sm text-tertiary">
              {m.computer_no_code_agents()}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function computerVersionLabel(computer: ComputerDetailView) {
  return computer.computerVersion ? `v${computer.computerVersion}` : m.computer_metadata_unknown();
}
