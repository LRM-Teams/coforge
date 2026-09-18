import { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCcw01 as Refresh } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { formatAgentProfileParam } from "@/features/agents/profile-panel/profile-panel-search";
import type { KeyPointExtractionMeta } from "./records-content";
import { ReportSectionEditor } from "./report-editor/report-section-editor";

export const KEY_POINT_EXTRACTION_TAB = "✨ 要点提炼";

/** Leader-only personal key-point extraction panel (design: purple prompt + result). */
export function KeyPointExtractionPanel({
  extraction,
  assistantAgentId,
  restartBusy,
  onRestart,
}: {
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  restartBusy?: boolean;
  onRestart?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const prompt = extraction?.promptSnapshot?.trim() ?? "";
  const status = extraction?.status;
  const canRestart =
    Boolean(onRestart) &&
    status !== undefined &&
    status !== "generating" &&
    (status === "ready" || status === "failed" || status === "pending_setup");

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-primary">
            {m.records_key_points_personal_prompt_label()}
          </h2>
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
        <div className="rounded-xl border border-brand-secondary/30 bg-brand-primary/10 px-3 py-3">
          <p
            className={`text-sm leading-6 whitespace-pre-wrap text-secondary ${expanded ? "" : "line-clamp-3"}`}
          >
            {prompt || m.records_key_points_prompt_empty()}
          </p>
          {prompt.length > 80 ? (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-secondary"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <>
                  <ChevronUp className="size-3.5" aria-hidden="true" />
                  {m.records_key_points_collapse()}
                </>
              ) : (
                <>
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                  {m.records_key_points_expand()}
                </>
              )}
            </button>
          ) : null}
        </div>
      </section>

      {status === "generating" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
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
      {status === "ready" && extraction?.markdown ? (
        <ReportSectionEditor
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
        <p className="text-sm text-tertiary">{m.records_key_points_waiting_submit()}</p>
      ) : null}
    </div>
  );
}
