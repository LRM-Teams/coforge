import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUp,
  Check,
  Edit01 as Pencil,
  RefreshCw01 as RotateCw,
} from "@untitledui/icons";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { BadgeWithIcon } from "@/components/base/badges/badges";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { useAppToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import { BackToComputers, useUpgradingComputer } from "./computer-layout";
import {
  computerLabel,
  isComputerUpdateAvailable,
  operatingSystemLabel,
  type ComputerIdentity,
} from "./computer-identity";
import { describeComputerUpgradeFailure } from "./upgrade-failure";
import { ComputerTile } from "./computer-tile";
import { RuntimeIdentity, RuntimeUsage, type UsageView } from "./runtime-usage";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";
import { Input } from "@/components/base/input/input";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_POLLS = 31;
/** How long the inline "upgraded" confirmation stays before the meta line speaks for itself. */
export const UPGRADE_CONFIRMATION_MS = 6_000;

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
  onUpgrade,
  onReadUpgradeStatus,
  latestComputerVersion,
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
  onUpgrade?: (requestId: string) => Promise<ComputerUpgradeStatus>;
  onReadUpgradeStatus?: (requestId: string) => Promise<ComputerUpgradeStatus>;
  latestComputerVersion?: string | null;
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
  const toast = useAppToast();
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const { upgradingComputerId, setUpgradingComputerId } = useUpgradingComputer();
  const [upgrade, setUpgrade] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "succeeded"; version: string }
    | { state: "failed"; reason: string }
  >({ state: "idle" });
  const upgrading = upgrade.state === "running" || upgradingComputerId === computer.id;
  const upgradeAvailable =
    onUpgrade &&
    computer.ownedByCurrentUser &&
    isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion);
  // The confirmation is a courtesy; the meta line's version is the durable answer.
  useEffect(() => {
    if (upgrade.state !== "succeeded") return;
    const timer = window.setTimeout(
      () => mountedRef.current && setUpgrade({ state: "idle" }),
      UPGRADE_CONFIRMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [upgrade]);
  const runUpgrade = async () => {
    if (!onUpgrade) return;
    const requestId = crypto.randomUUID();
    setUpgrade({ state: "running" });
    setUpgradingComputerId(computer.id);
    const settle = (update: () => void) => {
      if (mountedRef.current) update();
    };
    try {
      const accepted = await onUpgrade(requestId);
      if (accepted.status !== "accepted")
        throw new Error(describeComputerUpgradeFailure({ reason: "publication" }));
      if (!onReadUpgradeStatus) return;
      for (let poll = 0; poll < restartMaxPolls; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, restartPollIntervalMs));
        const status = await onReadUpgradeStatus(requestId);
        if (status.status === "completed" && status.computerVersion) {
          settle(() => setUpgrade({ state: "succeeded", version: status.computerVersion }));
          return;
        }
        if (status.status === "completed")
          throw new Error(describeComputerUpgradeFailure({ reason: "evidence" }));
        if (status.status === "failed") throw new Error(describeComputerUpgradeFailure(status));
        if (status.status === "unknown")
          throw new Error(describeComputerUpgradeFailure({ reason: "evidence" }));
      }
      throw new Error(describeComputerUpgradeFailure({ reason: "timeout" }));
    } catch (error) {
      settle(() =>
        setUpgrade({
          state: "failed",
          reason:
            error instanceof Error
              ? error.message
              : describeComputerUpgradeFailure({ reason: "timeout" }),
        }),
      );
    } finally {
      settle(() => setUpgradingComputerId(undefined));
    }
  };
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
        <ComputerTile computer={computer} online={computer.online} />
        <div className="min-w-0 flex-1">
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
              <Input
                aria-label={m.computer_display_name()}
                size="sm"
                autoFocus
                isRequired
                maxLength={200}
                value={displayNameDraft}
                isDisabled={savingDisplayName}
                onChange={setDisplayNameDraft}
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
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-primary">
                {computerLabel(computer)}
              </h1>
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
            </div>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-tertiary">
            <span>{computer.name}</span>
            <span aria-hidden="true">·</span>
            <span>{operatingSystemLabel(computer)}</span>
            <span aria-hidden="true">·</span>
            <span>{computerVersionLabel(computer)}</span>
            {upgrading ? (
              <span className="inline-flex items-center gap-1 text-brand-secondary">
                <LoadingIndicator className="size-3.5" label={m.computer_upgrade_in_progress()} />
                <span>{m.computer_upgrade_in_progress()}</span>
              </span>
            ) : upgrade.state === "succeeded" ? (
              <span className="inline-flex items-center gap-1 text-success-primary">
                <Check className="size-3.5" />
                <span>{m.computer_upgrade_succeeded_inline()}</span>
              </span>
            ) : upgrade.state === "failed" ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-error-primary">
                <AlertCircle className="size-3.5 shrink-0" />
                <span className="truncate">{upgrade.reason}</span>
              </span>
            ) : (
              upgradeAvailable &&
              latestComputerVersion && (
                <BadgeWithIcon color="brand" size="sm" type="pill-color" iconLeading={ArrowUp}>
                  {m.computer_new_version({ version: latestComputerVersion })}
                </BadgeWithIcon>
              )
            )}
            {computer.creator && (
              <Tooltip
                title={m.computer_added_by_name({
                  name: computer.creator.displayName || computer.creator.username,
                })}
              >
                <TooltipTrigger className="ml-1 rounded-full">
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
                  <span className="sr-only">
                    {computer.creator.displayName || computer.creator.username}
                  </span>
                </TooltipTrigger>
              </Tooltip>
            )}
          </p>
        </div>
        {onRestart && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {upgradeAvailable && upgrade.state !== "succeeded" && latestComputerVersion && (
              <Button
                type="button"
                size="md"
                color={upgrade.state === "failed" ? "secondary" : "primary"}
                iconLeading={ArrowUp}
                isLoading={upgrading}
                showTextWhileLoading
                isDisabled={upgrading}
                onPress={() => void runUpgrade()}
              >
                {upgrading
                  ? m.computer_upgrade_in_progress()
                  : upgrade.state === "failed"
                    ? m.computer_upgrade_retry()
                    : m.computer_upgrade_action({
                        version: shortReleaseVersion(latestComputerVersion),
                      })}
              </Button>
            )}
            <Button
              type="button"
              size="md"
              color="secondary"
              iconLeading={RotateCw}
              isDisabled={upgrading || restartState === "pending" || restartState === "accepted"}
              onPress={() => {
                setRestartState("pending");
                const requestId = crypto.randomUUID();
                // The restart poll outlives navigation; only touch state while still mounted.
                const settle = (update: () => void) => {
                  if (mountedRef.current) update();
                };
                void onRestart(requestId)
                  .then(async (initial) => {
                    if (initial.status !== "accepted") return initial;
                    settle(() => {
                      setRestartState("accepted");
                      toast.success(m.computer_restart_accepted());
                    });
                    if (!onReadRestartStatus) return initial;
                    for (let poll = 0; poll < restartMaxPolls; poll += 1) {
                      await new Promise((resolve) =>
                        window.setTimeout(resolve, restartPollIntervalMs),
                      );
                      const result = await onReadRestartStatus(requestId);
                      if (result.status !== "accepted") return result;
                    }
                    return { requestId, status: "failed" as const, reason: "timeout" as const };
                  })
                  .then(
                    (result) =>
                      settle(() => {
                        if (result.status === "completed") {
                          setRestartState("completed");
                          toast.success(
                            m.computer_restart_completed({
                              version: result.daemonVersion,
                              process: result.workerInstanceId,
                            }),
                          );
                        } else if (result.status === "accepted") {
                          setRestartState("accepted");
                        } else {
                          setRestartState("error");
                          toast.error(m.computer_restart_error());
                        }
                      }),
                    () =>
                      settle(() => {
                        setRestartState("error");
                        toast.error(m.computer_restart_error());
                      }),
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

/** The part a reader distinguishes releases by: `0.1.0-dev.29` reads as `dev.29`. */
function shortReleaseVersion(version: string) {
  const tail = version.split("-").at(-1);
  return tail && tail !== version ? tail : version;
}

function computerVersionLabel(computer: ComputerDetailView) {
  return computer.computerVersion ? `v${computer.computerVersion}` : m.computer_metadata_unknown();
}
