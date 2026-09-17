import { useEffect, useRef, useState, type ReactNode } from "react";
import { Edit01 as Pencil, RefreshCw01 as RotateCw } from "@untitledui/icons";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { useAppToast } from "@/components/ui/toast";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { BackToComputers, useUpgradingComputer } from "./computer-layout";
import {
  computerLabel,
  isComputerUpdateAvailable,
  operatingSystemLabel,
  type ComputerIdentity,
} from "./computer-identity";
import {
  describeComputerUpgradeFailure,
  describeComputerUpgradeSuccess,
  describeUpgradeRequestError,
} from "./upgrade-failure";
import { ComputerTile } from "./computer-tile";
import { RuntimeIdentity, RuntimeUsage, type UsageView } from "./runtime-usage";
import type { ComputerRestartStatus, ComputerUpgradeStatus } from "./computer.schemas";

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
    { state: "idle" } | { state: "running" } | { state: "failed"; reason: string; errorId?: string }
  >({ state: "idle" });
  const upgrading = upgrade.state === "running" || upgradingComputerId === computer.id;
  const upgradeAvailable =
    onUpgrade &&
    computer.ownedByCurrentUser &&
    isComputerUpdateAvailable(computer.computerVersion, latestComputerVersion);
  const canEditDisplayName = computer.ownedByCurrentUser && Boolean(onUpdateDisplayName);
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
          // The version itself moves to the Version row (the caller invalidates the loader); the
          // toast is only the one-line confirmation that the action just taken succeeded.
          settle(() => {
            toast.success(describeComputerUpgradeSuccess(status.computerVersion));
            setUpgrade({ state: "idle" });
          });
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
      settle(() => {
        const copy = describeUpgradeRequestError(error);
        setUpgrade({ state: "failed", reason: copy.headline, errorId: copy.errorId });
      });
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

  const upgradeButton =
    upgradeAvailable && latestComputerVersion ? (
      <Button
        type="button"
        size="sm"
        color="secondary"
        isLoading={upgrading}
        showTextWhileLoading
        isDisabled={upgrading}
        onPress={() => void runUpgrade()}
      >
        {upgrading
          ? m.computer_upgrade_in_progress()
          : m.computer_upgrade_action({ version: shortReleaseVersion(latestComputerVersion) })}
      </Button>
    ) : undefined;

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
        <BackToComputers />
        {onRestart && (
          <Button
            type="button"
            size="sm"
            color="secondary"
            className="ml-auto"
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
        )}
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <ComputerTile computer={computer} online={computer.online} size="xl" />
            {editingDisplayName ? (
              <form
                className="w-full max-w-sm"
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
                <div className="mt-2 flex justify-center gap-2">
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
              // The pencil hangs off the name's right edge so the name itself stays centred.
              <div className="relative max-w-[calc(100%-5rem)]">
                <h1 className="truncate text-3xl font-semibold text-primary">
                  {computerLabel(computer)}
                </h1>
                {canEditDisplayName && (
                  <ButtonUtility
                    type="button"
                    size="sm"
                    color="tertiary"
                    icon={Pencil}
                    className="absolute top-1/2 left-full ml-1 -translate-y-1/2"
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
          </div>

          <DetailGroup>
            <dl className="divide-y divide-secondary">
              <DetailRow
                label={m.computer_hostname()}
                value={<span className="font-mono">{computer.name}</span>}
              />
              <DetailRow label={m.computer_system()} value={operatingSystemLabel(computer)} />
              <DetailRow
                label={m.computer_version()}
                value={<span className="font-mono">{computerVersionLabel(computer)}</span>}
                action={upgradeButton}
                footer={
                  upgrade.state === "failed" ? (
                    <div role="alert" className="mt-1.5 text-sm text-error-primary">
                      <p>{upgrade.reason}</p>
                      {upgrade.errorId && (
                        <p className="mt-0.5 text-xs text-tertiary">
                          {m.computer_upgrade_error_reference({ id: upgrade.errorId })}
                        </p>
                      )}
                    </div>
                  ) : undefined
                }
              />
              {computer.creator && (
                <DetailRow
                  label={m.computer_added_by()}
                  value={
                    <span className="flex min-w-0 items-center justify-end gap-2">
                      <Avatar
                        size="xs"
                        src={computer.creator.avatarUrl}
                        alt=""
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
                    </span>
                  }
                />
              )}
            </dl>
          </DetailGroup>

          <section aria-labelledby="computer-code-agents">
            <DetailGroup heading={m.computer_code_agents()} headingId="computer-code-agents">
              {computer.runtimes.length ? (
                <ul className="divide-y divide-secondary">
                  {computer.runtimes.map((runtime) => (
                    <li
                      key={runtime.provider}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-3 text-sm"
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
                <p className="py-6 text-center text-sm text-tertiary">
                  {m.computer_no_code_agents()}
                </p>
              )}
            </DetailGroup>
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * The subtle-fill container shared by both detail groups: no border, no
 * shadow, an optional heading inset to the row text, dividers between rows
 * supplied by the child list itself (`dl`/`ul` with `divide-y`).
 */
function DetailGroup({
  heading,
  headingId,
  children,
}: {
  heading?: string;
  headingId?: string;
  children: ReactNode;
}) {
  return (
    <div>
      {heading && (
        <h2 id={headingId} className="mb-2 px-4 text-sm font-semibold text-primary">
          {heading}
        </h2>
      )}
      <div className="rounded-xl bg-secondary px-4">{children}</div>
    </div>
  );
}

/**
 * One label—value row: label left, value (and an optional action that acts
 * on it) right, on a single line that never wraps. `footer` is an optional
 * full-width block below that line, such as an upgrade failure explanation.
 */
function DetailRow({
  label,
  value,
  action,
  footer,
}: {
  label: string;
  value: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 py-3 @max-md:items-start">
      <dt className="text-sm leading-6 font-medium whitespace-nowrap text-primary">{label}</dt>
      {/* When the value and its action do not fit beside the label, the action drops below. */}
      <dd className="flex min-h-6 min-w-0 flex-wrap items-center justify-end gap-2 text-sm text-tertiary">
        <span className="min-w-0 truncate">{value}</span>
        {action && <span className="shrink-0">{action}</span>}
      </dd>
      {footer && <dd className="col-span-2">{footer}</dd>}
    </div>
  );
}

/** The part a reader distinguishes releases by: `0.1.0-dev.29` reads as `dev.29`. */
function shortReleaseVersion(version: string) {
  const tail = version.split("-").at(-1);
  return tail && tail !== version ? tail : version;
}

function computerVersionLabel(computer: ComputerDetailView) {
  return computer.computerVersion || "—";
}
