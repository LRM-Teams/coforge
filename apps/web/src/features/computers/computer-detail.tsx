import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { RuntimeProvider } from "@coforge/protocol";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDateForDisplay } from "@/lib/dates";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";
import { computerLabel, type ComputerIdentity } from "./computer-identity";
import { ComputerTile } from "./computer-tile";
import { RuntimeUsage, type UsageView } from "./runtime-usage";

export type ComputerDetailView = ComputerIdentity & {
  id: string;
  ownedByCurrentUser: boolean;
  online: boolean;
  connectedAt: Date | string;
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
}: {
  computer: ComputerDetailView;
  timeZone?: string | null;
  onScanUsage: (provider: RuntimeProvider) => Promise<void>;
  onSetRuntimePublic: (runtimeId: string, isPublic: boolean) => Promise<void>;
}) {
  const [updatingRuntimeId, setUpdatingRuntimeId] = useState<string>();
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
      />

      <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
        <section aria-labelledby="computer-overview">
          <h2 id="computer-overview" className="text-sm font-semibold">
            {m.computer_overview()}
          </h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_machine_id()}</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-sm">{computer.machineId}</span>
                <CopyMachineId machineId={computer.machineId} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{m.computer_connected_at()}</dt>
              <dd className="mt-1 text-sm">
                {formatDateForDisplay(computer.connectedAt, timeZone)}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="computer-code-agents">
          <h2 id="computer-code-agents" className="text-sm font-semibold">
            {m.computer_code_agents()}
          </h2>
          {computer.runtimes.length ? (
            <ul className="mt-3 grid gap-3">
              {computer.runtimes.map((runtime) => (
                <li key={runtime.provider} className="rounded-xl border p-4 text-sm">
                  {computer.ownedByCurrentUser ? (
                    <RuntimeUsage
                      runtime={runtime}
                      usage={computer.usage?.[runtime.provider]}
                      timeZone={timeZone}
                      onScan={() => onScanUsage(runtime.provider)}
                    />
                  ) : (
                    <div className="border-b pb-3">
                      <p className="truncate font-medium">{runtime.displayName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.computer_runtime_version({ version: runtime.version })}
                      </p>
                    </div>
                  )}
                  {computer.ownedByCurrentUser && (
                    <div className="mt-3 flex justify-end">
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
                            : m.computer_runtime_publish_label({ runtime: runtime.displayName })
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

export const COPIED_FEEDBACK_MS = 2000;

export function CopyMachineId({
  machineId,
  feedbackMs = COPIED_FEEDBACK_MS,
}: {
  machineId: string;
  feedbackMs?: number;
}) {
  // Counting presses rather than holding a boolean: pressing again inside the
  // window is a new confirmation, and a boolean already true would not restart
  // the timer, so the second press would inherit the first one's remaining ms.
  const [copiedAt, setCopiedAt] = useState(0);
  const copied = copiedAt > 0;

  // The confirmation is feedback for one press, not a state the button stays
  // in, so it expires on its own and never outlives the panel.
  useEffect(() => {
    if (!copiedAt) return;
    const timer = window.setTimeout(() => setCopiedAt(0), feedbackMs);
    return () => window.clearTimeout(timer);
  }, [copiedAt, feedbackMs]);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? m.computer_machine_id_copied() : m.computer_copy_machine_id()}
      onClick={async () => {
        // Clipboard access is refused outside a secure context, and a machine
        // id the User can still read and select by hand is not worth an error.
        try {
          await navigator.clipboard.writeText(machineId);
          setCopiedAt((presses) => presses + 1);
        } catch {
          setCopiedAt(0);
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
