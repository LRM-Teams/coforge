import { useState } from "react";
import { AlertCircle, Stars01 as Stars, XClose as X } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { Heading, Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { m } from "@/paraglide/messages";
import type { KeyPointExtractionMeta } from "./records-content";
import { KeyPointExtractionPanel } from "./key-point-extraction-panel";

/** Overview-page team key-point block: start button + shared extraction panel. */
export function TeamKeyPointSection({
  overviewReportId,
  extraction,
  assistantAgentId,
  busy,
  onStart,
}: {
  overviewReportId: string;
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  busy?: boolean;
  onStart: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = extraction?.status;
  const canStart =
    status !== "generating" &&
    (status === undefined ||
      status === "ready" ||
      status === "failed" ||
      status === "pending_setup");
  const willOverwrite = status === "ready";

  function onPressStart() {
    if (willOverwrite) {
      setConfirmOpen(true);
      return;
    }
    onStart();
  }

  return (
    <section className="mt-8 space-y-4 border-t border-secondary pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-primary">
            {m.records_key_points_team_section_title()}
          </h2>
          <p className="text-sm text-tertiary">{m.records_key_points_team_section_hint()}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/records/settings"
            search={{
              tab: "weekly",
              section: "key_points",
              slot: "team",
              returnTo: `/records/${overviewReportId}`,
            }}
            className="text-sm font-medium text-brand-secondary hover:underline"
          >
            {m.records_key_points_edit_prompt()}
          </Link>
          {canStart ? (
            <Button
              type="button"
              size="sm"
              color="primary"
              iconLeading={Stars}
              isDisabled={busy}
              onPress={onPressStart}
            >
              {status ? m.records_key_points_team_restart() : m.records_key_points_team_start()}
            </Button>
          ) : null}
        </div>
      </div>

      {status ? (
        <KeyPointExtractionPanel
          extraction={extraction}
          assistantAgentId={assistantAgentId}
          waitingLabel={m.records_key_points_team_waiting()}
          className="px-0 py-0 sm:px-0 sm:py-0"
        />
      ) : (
        <p className="text-sm text-tertiary">{m.records_key_points_team_waiting()}</p>
      )}

      <ModalOverlay
        isOpen={confirmOpen}
        onOpenChange={(value) => {
          if (busy) return;
          setConfirmOpen(value);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="p-6">
            {({ close }) => (
              <>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={busy}
                  className="absolute top-4 right-4"
                  onClick={close}
                />
                <div className="flex items-start gap-3 pr-8">
                  <FeaturedIcon color="warning" theme="light" size="sm" icon={AlertCircle} />
                  <div className="min-w-0 space-y-2">
                    <Heading slot="title" className="text-base font-semibold text-primary">
                      {m.records_key_points_team_restart_confirm_title()}
                    </Heading>
                    <Text slot="description" className="text-sm text-secondary">
                      {m.records_key_points_team_restart_confirm_body()}
                    </Text>
                  </div>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    isDisabled={busy}
                    onPress={close}
                  >
                    {m.records_template_cancel()}
                  </Button>
                  <Button
                    type="button"
                    color="primary"
                    size="sm"
                    isDisabled={busy}
                    onPress={() => {
                      setConfirmOpen(false);
                      onStart();
                    }}
                  >
                    {m.records_key_points_team_restart()}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  );
}
