import { useState } from "react";
import { Pencil, RotateCw } from "lucide-react";
import type { RuntimeProvider } from "@coforge/protocol";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";
import { computerLabel, type ComputerIdentity } from "./computer-identity";
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
  const [updatingRuntimeId, setUpdatingRuntimeId] = useState<string>();
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(computer.displayName);
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [displayNameError, setDisplayNameError] = useState(false);
  const [restartState, setRestartState] = useState<
    "idle" | "pending" | "accepted" | "completed" | "error"
  >("idle");
  const [restartResult, setRestartResult] = useState<ComputerRestartStatus>();
  const setRuntimePublic = async (runtimeId: string, isPublic: boolean) => {
    setUpdatingRuntimeId(runtimeId);
    try {
      await onSetRuntimePublic(runtimeId, isPublic);
    } finally {
      setUpdatingRuntimeId(undefined);
    }
  };

  return (
    <>
      <PageHeader
        leading={
          <>
            <BackToComputers />
            <ComputerTile computer={computer} />
          </>
        }
        heading={computerLabel(computer)}
        meta={<StatusPill online={computer.online} />}
        actions={
          onRestart ? (
            <Button
              type="button"
              variant="outline"
              disabled={restartState === "pending" || restartState === "accepted"}
              onClick={() => {
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
              <RotateCw aria-hidden="true" />
              {restartState === "pending"
                ? m.computer_restart_requesting()
                : m.computer_restart_action()}
            </Button>
          ) : undefined
        }
      />

      <div className="@container flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
        {restartState === "accepted" && (
          <p role="status" className="rounded-lg border border-success/40 p-3 text-sm">
            {m.computer_restart_accepted()}
          </p>
        )}
        {restartState === "completed" && restartResult?.status === "completed" && (
          <p role="status" className="rounded-lg border border-success/40 p-3 text-sm">
            {m.computer_restart_completed({
              version: restartResult.daemonVersion,
              process: restartResult.workerInstanceId,
            })}
          </p>
        )}
        {restartState === "error" && (
          <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
            {m.computer_restart_error()}
          </p>
        )}
        <section aria-labelledby="computer-overview">
          <h2 id="computer-overview" className="text-sm font-semibold">
            {m.computer_overview()}
          </h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_display_name()}</dt>
              <dd className="mt-1 text-sm">
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
                      className="h-9 w-full rounded-md border bg-background px-3 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    <div className="mt-2 flex gap-2">
                      <Button type="submit" size="sm" disabled={savingDisplayName}>
                        {savingDisplayName
                          ? m.computer_display_name_saving()
                          : m.computer_display_name_save()}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={savingDisplayName}
                        onClick={() => {
                          setDisplayNameDraft(computer.displayName);
                          setDisplayNameError(false);
                          setEditingDisplayName(false);
                        }}
                      >
                        {m.computer_display_name_cancel()}
                      </Button>
                    </div>
                    {displayNameError && (
                      <p role="alert" className="mt-2 text-xs text-destructive">
                        {m.computer_display_name_error()}
                      </p>
                    )}
                  </form>
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{computer.displayName}</span>
                    {computer.ownedByCurrentUser && onUpdateDisplayName && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={m.computer_display_name_edit()}
                        onClick={() => {
                          setDisplayNameDraft(computer.displayName);
                          setDisplayNameError(false);
                          setEditingDisplayName(true);
                        }}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                    )}
                  </span>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_name()}</dt>
              <dd className="mt-1 truncate text-sm">{computer.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_connected_at()}</dt>
              <dd className="mt-1 text-sm">
                <RelativeTime value={computer.connectedAt} timeZone={timeZone} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_version()}</dt>
              <dd className="mt-1 break-words text-sm">
                {computer.computerVersion || m.computer_metadata_unknown()}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_os()}</dt>
              <dd className="mt-1 break-words text-sm">{operatingSystemLabel(computer)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_creator()}</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2 text-sm">
                {computer.creator ? (
                  <>
                    <Avatar
                      size="sm"
                      people={[
                        {
                          name: computer.creator.displayName || computer.creator.username,
                          src: computer.creator.avatarUrl,
                        },
                      ]}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {computer.creator.displayName || computer.creator.username}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        @{computer.creator.username}
                      </span>
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
          <h2 id="computer-code-agents" className="text-sm font-semibold">
            {m.computer_code_agents()}
          </h2>
          {computer.runtimes.length ? (
            <ul className="mt-3 grid items-start gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {computer.runtimes.map((runtime) => (
                <li
                  key={runtime.provider}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-xl border p-4 text-sm"
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
                        variant="outline"
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
                        disabled={updatingRuntimeId === runtime.id}
                        onClick={() => void setRuntimePublic(runtime.id, !runtime.isPublic)}
                      >
                        {runtime.isPublic
                          ? m.computer_runtime_public()
                          : m.computer_runtime_private()}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              {m.computer_no_code_agents()}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function operatingSystemLabel(computer: ComputerDetailView) {
  const name =
    computer.platform === "darwin"
      ? "macOS"
      : computer.platform === "linux"
        ? "Linux"
        : computer.platform === "win32"
          ? "Windows"
          : undefined;
  return name
    ? `${name} ${computer.osVersion || m.computer_metadata_unknown()}`
    : m.computer_metadata_unknown();
}

function StatusPill({ online }: { online: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full", online ? "bg-success" : "bg-offline")}
      />
      {online ? m.computer_status_online() : m.computer_status_offline()}
    </span>
  );
}
