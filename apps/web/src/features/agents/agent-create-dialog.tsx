import { useState, type FormEvent } from "react";
import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Monitor01 as Monitor } from "@untitledui/icons";

import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { localizeHref } from "@/paraglide/runtime";
import { Button } from "@/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { HintText } from "@/components/base/input/hint-text";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { m } from "@/paraglide/messages";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";

export type AgentCreateComputerOption = {
  id: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

/** The Agent-create form, shared by the Members page ("New agent") and an `agent:create`
 * action card's commit button (ADR 0027 "Commit and cancel"). `defaults` prefills the form;
 * `computerLocked` mirrors a card's `requiredComputer` by disabling the Computer selector. */
export function AgentCreateDialog({
  open,
  onOpenChange,
  computers,
  onCreate,
  onLoadRuntimeCatalog,
  defaults,
  computerLocked = false,
  actionCardMessageId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computers: AgentCreateComputerOption[];
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  defaults?: { name?: string; description?: string; computerId?: string };
  computerLocked?: boolean;
  actionCardMessageId?: string;
  onCreated?: (result: { startPublished: boolean }) => void;
}) {
  const [submitting, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const [computerId, setComputerId] = useState(defaults?.computerId ?? computers[0]?.id ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (!name) {
      setError(m.agent_form_required_error());
      return;
    }
    await guard(async () => {
      try {
        const result = await onCreate({
          name,
          description,
          provider: parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE,
          model: String(form.get("model") ?? "").trim() || undefined,
          modelProvider: String(form.get("modelProvider") ?? "").trim() || undefined,
          reasoning: String(form.get("reasoning") ?? "").trim(),
          apiKey: String(form.get("apiKey") ?? "").trim() || undefined,
          computerId: String(form.get("computerId") ?? ""),
          actionCardMessageId,
        });
        formElement.reset();
        onOpenChange(false);
        onCreated?.(result);
      } catch {
        setError(m.agent_form_server_error());
      }
    });
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg rounded-2xl">
        <Dialog>
          {({ close }) =>
            computers.length ? (
              <form onSubmit={submit}>
                <DialogHeader
                  title={m.agent_form_title()}
                  description={m.agent_form_description()}
                  onClose={close}
                />
                <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                  <Select
                    name="computerId"
                    isRequired
                    isDisabled={computerLocked}
                    size="md"
                    label={m.agent_form_computer()}
                    className="min-w-0 sm:col-span-2"
                    selectedKey={computerId}
                    onSelectionChange={(key) => {
                      if (key !== null) setComputerId(String(key));
                    }}
                  >
                    {computers.map((computer) => (
                      <Select.Item
                        key={computer.id}
                        id={computer.id}
                        label={computer.displayName}
                        aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                        icon={
                          <span
                            role="img"
                            aria-label={
                              computer.online
                                ? m.computer_status_online()
                                : m.computer_status_offline()
                            }
                            className={`size-2 shrink-0 rounded-full ${computer.online ? "bg-online" : "bg-offline"}`}
                          />
                        }
                      />
                    ))}
                  </Select>
                  <Input
                    label={m.agent_form_username()}
                    name="name"
                    isRequired
                    defaultValue={defaults?.name}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    placeholder="release-fix"
                    hint={m.agent_form_username_hint()}
                    className="min-w-0 sm:col-span-2"
                  />
                  <TextArea
                    label={m.agent_profile_description()}
                    name="description"
                    rows={3}
                    defaultValue={defaults?.description}
                    placeholder={m.agent_form_description_placeholder()}
                    className="min-w-0 sm:col-span-2"
                  />
                  <AgentRuntimeFields
                    key={computerId}
                    open={open}
                    computerId={computerId}
                    onLoad={async (id) => ({
                      providers:
                        computers
                          .find((computer) => computer.id === id)
                          ?.runtimes.map((runtime) => runtime.provider) ?? [],
                      catalogs: await onLoadRuntimeCatalog(id),
                    })}
                  />
                  {error && (
                    <HintText isInvalid role="alert" className="sm:col-span-2">
                      {error}
                    </HintText>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-secondary px-6 py-4 sm:flex sm:justify-end">
                  <Button
                    type="button"
                    color="secondary"
                    size="lg"
                    isDisabled={submitting}
                    onPress={() => onOpenChange(false)}
                  >
                    {m.controls_cancel()}
                  </Button>
                  <Button type="submit" size="lg" isDisabled={submitting}>
                    {submitting ? m.agent_form_submitting() : m.agent_form_submit()}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="p-6">
                <div
                  aria-hidden="true"
                  className="mb-5 flex size-12 items-center justify-center rounded-xl bg-primary text-tertiary shadow-xs ring-1 ring-secondary ring-inset"
                >
                  <Monitor className="size-6" />
                </div>
                <DialogHeader
                  title={m.agent_form_title()}
                  description={m.agent_empty_computer_description()}
                  className="px-0 pt-0"
                />
                <div className="mt-6 flex flex-wrap justify-end gap-3">
                  <Button color="secondary" onPress={() => onOpenChange(false)}>
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    href={localizeHref("/computers")}
                    className="h-11"
                    onPress={() => onOpenChange(false)}
                  >
                    {m.agent_connect_computer()}
                  </Button>
                </div>
              </div>
            )
          }
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
