import { RefreshCcw01 as RotateCcw, Stop, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { m } from "@/paraglide/messages";
import type { AgentRuntimeControls } from "./agent-runtime-controls";

/**
 * The Stop-confirm and Restart/Reset/Full-reset dialogs, rendered once per host (the full Agent
 * detail page's `AgentControl`, or the Agent profile side panel) and driven entirely by a shared
 * `useAgentRuntimeControls()` instance — one implementation instead of the two the header icon
 * buttons and the Actions section would otherwise each need. Markup, classNames and
 * `data-control-*` selectors are unchanged from the pre-refactor `AgentControl` component, so
 * `apps/web/test/agent-control.e2e.ts` keeps compiling against them.
 */
export function AgentControlDialogs({
  agentName,
  control,
}: {
  agentName: string;
  control: AgentRuntimeControls;
}) {
  return (
    <>
      <ModalOverlay
        isOpen={control.stopConfirmOpen}
        onOpenChange={(nextOpen: boolean) => {
          if (control.stopPending) return;
          if (!nextOpen) control.closeStopConfirm();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="overflow-hidden text-left">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-2xl"
                  >
                    {m.agent_control_stop_dialog_title()}
                  </Heading>
                  <ButtonUtility
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    isDisabled={control.stopPending}
                    onClick={close}
                  />
                </div>
                {/* `block`, because an inline `Text` puts its horizontal padding on the first and
                    last line only: the padding is on the paragraph's start and end edges, not on
                    every line, so a wrapped second line escapes to the dialog's edge and can be
                    clipped by its rounded corner. */}
                <Text slot="description" className="block px-6 pt-4 text-sm text-tertiary">
                  {m.agent_control_stop_message({ name: agentName })}
                </Text>
                {control.startStopError && (
                  <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                    {control.startStopError}
                  </p>
                )}
                <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" isDisabled={control.stopPending} onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  {/* `iconLeading`, not a child element: the button wraps every child — icon
                      included — in its one text span, and a block-level `svg` inside that inline
                      span takes its own line, so the label drops below the icon. */}
                  <Button
                    color="primary"
                    data-control-stop-confirm
                    isDisabled={control.stopPending}
                    iconLeading={Stop}
                    onPress={control.confirmStop}
                  >
                    {control.stopPending
                      ? m.agent_control_stop_pending()
                      : m.agent_control_stop_confirm()}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <ModalOverlay isOpen={control.restartOpen} onOpenChange={control.closeRestart}>
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog className="overflow-hidden text-left">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
                  <Heading
                    slot="title"
                    className="min-w-0 text-xl font-semibold text-primary wrap-anywhere sm:text-2xl"
                  >
                    {m.agent_control_dialog_title({ name: agentName })}
                  </Heading>
                  <ButtonUtility
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    onClick={close}
                  />
                </div>
                <Text slot="description" className="sr-only">
                  {control.selected.description}
                </Text>
                <div
                  className="grid min-h-0 gap-3 overflow-y-auto px-6 py-6"
                  role="group"
                  aria-label={m.agent_control_title()}
                >
                  {control.options.map((option) => (
                    <Button
                      key={option.action}
                      color="secondary"
                      aria-label={option.label}
                      aria-pressed={control.action === option.action}
                      data-control-action={option.action}
                      className={`h-auto flex-col items-start whitespace-normal rounded-xl p-4 text-left ${control.action === option.action ? "border-brand bg-primary ring-1 ring-brand hover:bg-primary" : "hover:bg-secondary"}`}
                      onPress={() => control.setAction(option.action)}
                    >
                      <span className="block font-semibold">{option.label}</span>
                      <span className="mt-1 block text-sm font-normal leading-6 text-tertiary">
                        {option.description}
                      </span>
                    </Button>
                  ))}
                  {control.destructive && (
                    <p className="px-1 text-sm text-tertiary">
                      {m.agent_control_confirm_description()}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button color="secondary" onPress={close}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    color={control.destructive ? "primary-destructive" : "primary"}
                    data-control-submit
                    iconLeading={RotateCcw}
                    onPress={control.submitRestart}
                  >
                    {control.selected.label}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
