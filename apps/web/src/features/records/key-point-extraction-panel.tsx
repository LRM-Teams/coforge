import { RefreshCcw01 as Refresh } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/base/buttons/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { formatAgentProfileParam } from "@/features/agents/profile-panel/profile-panel-search";
import type { KeyPointExtractionMeta } from "./records-content";
import { ReportSectionEditor } from "./report-editor/report-section-editor";

export const KEY_POINT_EXTRACTION_TAB = "✨ 要点提炼";

/** Leader-only personal / team key-point extraction result panel. */
export function KeyPointExtractionPanel({
  extraction,
  assistantAgentId,
  restartBusy,
  onRestart,
  waitingLabel,
  /** Settings deep-link for the prompt editor (personal or team slot). */
  editPrompt,
  className,
}: {
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  restartBusy?: boolean;
  onRestart?: () => void;
  waitingLabel?: string;
  editPrompt?: {
    slot: "personal" | "team";
    returnTo: string;
  };
  className?: string;
}) {
  const status = extraction?.status;
  const canRestart =
    Boolean(onRestart) &&
    status !== undefined &&
    status !== "generating" &&
    (status === "ready" ||
      status === "failed" ||
      status === "pending_setup" ||
      status === "awaiting_confirm");
  const showActions = Boolean(editPrompt) || canRestart;

  return (
    <div
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6",
        className,
      )}
    >
      {showActions ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {editPrompt ? (
            <Link
              to="/records/settings"
              search={{
                tab: "weekly",
                section: "key_points",
                slot: editPrompt.slot,
                returnTo: editPrompt.returnTo,
              }}
              className="text-sm font-medium text-brand-secondary hover:underline"
            >
              {m.records_key_points_edit_prompt()}
            </Link>
          ) : null}
          {canRestart ? (
            <Button
              type="button"
              size="sm"
              color="secondary"
              iconLeading={Refresh}
              isDisabled={restartBusy}
              onPress={() => onRestart?.()}
            >
              {m.records_key_points_restart()}
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "generating" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
      ) : null}
      {status === "awaiting_confirm" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_awaiting_confirm()}</p>
      ) : null}
      {status === "pending_setup" ? (
        <div className="space-y-2 rounded-xl border border-secondary bg-warning-primary p-3">
          <p className="text-sm text-secondary">{m.records_key_points_pending_setup()}</p>
          {assistantAgentId ? (
            <Link
              to="/agents"
              search={{
                profile: formatAgentProfileParam(assistantAgentId),
                agentTab: "profile",
              }}
              className="text-sm font-semibold text-brand-secondary"
            >
              {m.records_weekly_ai_setup_action()}
            </Link>
          ) : null}
        </div>
      ) : null}
      {status === "failed" ? (
        <p className="text-sm text-error-primary">
          {extraction?.error?.trim() || m.records_key_points_failed()}
        </p>
      ) : null}
      {(status === "ready" || status === "generating" || status === "awaiting_confirm") &&
      extraction?.markdown ? (
        <ReportSectionEditor
          key={`${status}:${extraction.markdown.length}:${extraction.markdown.slice(0, 32)}`}
          defaultValue={extraction.markdown}
          editable={false}
          placeholder=""
          onUpdate={() => {}}
        />
      ) : null}
      {status === "ready" && !extraction?.markdown ? (
        <p className="text-sm text-tertiary">{m.records_key_points_empty_result()}</p>
      ) : null}
      {!status ? (
        <p className="text-sm text-tertiary">
          {waitingLabel ?? m.records_key_points_waiting_submit()}
        </p>
      ) : null}
    </div>
  );
}
