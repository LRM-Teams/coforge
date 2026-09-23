import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Trash01 } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { StatusDot } from "#src/components/ui/status-dot";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { m } from "#src/paraglide/messages";
import { agentEnvironmentRowsChanged } from "./agent-form";
import {
  AgentRuntimeFields,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields";

const MAX_ENV_ROWS = 64;

/** What the RUNTIME CONFIG section's own TanStack Query load of `getAgentEnvironment` looks like
 * by the time it reaches this form. `undefined` (not this type at all) means the viewer is not
 * the Agent's owner, so the whole Advanced disclosure is omitted (`agent-profile-panel.tsx`
 * never builds this object for a non-owner). `loaded: false` means the owner's query is still in
 * flight; the disclosure still renders (so its own trigger doesn't pop in later) but shows the
 * loading line and keeps Save disabled instead of seeding rows from an empty map. */
export type AgentEnvironmentState = { loaded: boolean; values: Record<string, string> };

export type AgentRuntimeComputerOption = {
  id: string;
  displayName: string;
  online?: boolean;
};

type EnvironmentRow = { key: string; value: string };

/**
 * The RUNTIME CONFIG pencil's form body: the same `AgentRuntimeFields` as the full page's edit
 * dialog, plus Save/Cancel and an inline error line. Kept as its own plain component (no
 * `Modal`/`Dialog`) so it renders outside a browser DOM — `Modal` needs a portal target
 * `renderToStaticMarkup` cannot provide (verified: it renders empty, no thrown error), so
 * `agent-runtime-config-dialog.test.tsx` renders this piece directly instead of the dialog shell.
 * Save stays disabled until `AgentRuntimeFields` reports an actual change via `onDirtyChange`, or
 * until the Advanced env rows differ from their loaded starting point.
 *
 * When `computers` is provided (Agent has no Computer yet, or the caller wants reassignment),
 * a Computer picker appears first so the unbound weekly-report assistant can bind and configure
 * in one save.
 */
export function AgentRuntimeConfigForm({
  computerId,
  computers,
  computerLocked = false,
  credentialConfigured = false,
  initial,
  onLoad,
  environment,
  saving,
  error,
  onClose,
  onSave,
}: {
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  /** Omitted entirely for a viewer who does not own the Agent. */
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  onClose?: () => void;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  const [selectedComputerId, setSelectedComputerId] = useState(
    computerId || computers?.[0]?.id || "",
  );
  useEffect(() => {
    if (computerId) setSelectedComputerId(computerId);
  }, [computerId]);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [envRows, setEnvRows] = useState<EnvironmentRow[]>([]);
  const seeded = useRef(false);
  useEffect(() => {
    if (!environment?.loaded || seeded.current) return;
    seeded.current = true;
    setEnvRows(Object.entries(environment.values).map(([key, value]) => ({ key, value })));
  }, [environment]);

  const envDirty = agentEnvironmentRowsChanged(envRows, environment?.values ?? {});
  const computerDirty = Boolean(computers) && selectedComputerId !== (computerId || "");
  const dirty = runtimeDirty || envDirty || computerDirty;
  const envPending = environment !== undefined && !environment.loaded;
  const showComputerPicker = Boolean(computers && computers.length > 0);

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave(new FormData(event.currentTarget), {
          runtime: runtimeDirty || computerDirty,
          environment: envDirty,
        });
      }}
    >
      <DialogHeader
        title={computerId ? m.agent_profile_edit_runtime_config() : m.agent_profile_setup_runtime()}
        onClose={onClose}
      />
      {/* One column, like Raft's dialog: the runtime fields stack (provider, then the model it
          belongs to, then reasoning) instead of splitting into two columns on a wide screen. */}
      <div className="grid gap-4 px-6 py-6">
        {showComputerPicker ? (
          <Select
            name="computerId"
            isRequired
            isDisabled={computerLocked || saving}
            size="md"
            label={m.agent_form_computer()}
            className="min-w-0"
            selectedKey={selectedComputerId || null}
            onSelectionChange={(key) => {
              if (key !== null) {
                setSelectedComputerId(String(key));
                setRuntimeDirty(true);
              }
            }}
          >
            {computers!.map((computer) => (
              <Select.Item
                key={computer.id}
                id={computer.id}
                label={computer.displayName}
                aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                icon={
                  <StatusDot
                    tone={computer.online ? "online" : "offline"}
                    label={
                      computer.online ? m.computer_status_online() : m.computer_status_offline()
                    }
                    className="size-2"
                  />
                }
              />
            ))}
          </Select>
        ) : computerId ? (
          <input type="hidden" name="computerId" value={computerId} />
        ) : null}
        {selectedComputerId ? (
          <AgentRuntimeFields
            key={selectedComputerId}
            open
            computerId={selectedComputerId}
            credentialConfigured={credentialConfigured}
            initial={initial}
            onLoad={onLoad}
            onDirtyChange={setRuntimeDirty}
          />
        ) : (
          <p className="text-sm text-tertiary">{m.agent_form_computer_required()}</p>
        )}
        {environment !== undefined && (
          // Raft's dialog shows this as a plain "More" disclosure — a small-caps trigger with a
          // chevron, not a bordered pill — whose panel is a titled section: the section's own
          // heading, one line saying what environment variables do, then the rows and the add
          // action. The heading and the line together replace what used to be a bordered box with
          // a trailing hint, which read as a stray control rather than a section of the form.
          <Disclosure className="sm:col-span-2">
            <Button
              slot="trigger"
              type="button"
              color="tertiary"
              size="sm"
              className="w-max gap-1 px-0 text-xs font-medium tracking-wide text-tertiary uppercase"
              iconLeading={ChevronDown}
            >
              {m.agent_env_more()}
            </Button>
            <DisclosurePanel className="grid gap-3 pt-3">
              {envPending ? (
                <p className="text-sm text-tertiary">{m.agent_env_loading()}</p>
              ) : (
                <>
                  <div className="grid gap-1">
                    <p className="text-xs font-medium tracking-wide text-tertiary uppercase">
                      {m.agent_env_title()}
                    </p>
                    <p className="text-sm text-tertiary">{m.agent_env_description()}</p>
                  </div>
                  {envRows.map((row, index) => (
                    <div key={index} className="flex min-w-0 items-center gap-2">
                      <Input
                        name="envKey"
                        size="sm"
                        className="min-w-0 flex-1"
                        placeholder={m.agent_env_key_placeholder()}
                        value={row.key}
                        onChange={(value) =>
                          setEnvRows(
                            envRows.map((r, i) => (i === index ? { ...r, key: value } : r)),
                          )
                        }
                      />
                      <span aria-hidden="true" className="text-tertiary">
                        =
                      </span>
                      <Input
                        name="envValue"
                        size="sm"
                        className="min-w-0 flex-1"
                        placeholder={m.agent_env_value_placeholder()}
                        value={row.value}
                        onChange={(value) =>
                          setEnvRows(envRows.map((r, i) => (i === index ? { ...r, value } : r)))
                        }
                      />
                      <ButtonUtility
                        type="button"
                        size="xs"
                        color="tertiary"
                        icon={Trash01}
                        aria-label={m.agent_env_remove_label({ index: index + 1 })}
                        onClick={() => setEnvRows(envRows.filter((_, i) => i !== index))}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    className="justify-self-start"
                    isDisabled={envRows.length >= MAX_ENV_ROWS}
                    onPress={() => setEnvRows([...envRows, { key: "", value: "" }])}
                  >
                    {m.agent_env_add()}
                  </Button>
                </>
              )}
            </DisclosurePanel>
          </Disclosure>
        )}
        {error && (
          <p role="alert" className="text-sm text-error-primary sm:col-span-2">
            {error}
          </p>
        )}
      </div>
      {/* Raft's footer is the save action alone; the dialog is dismissed by its header X, Esc or the
          overlay (all already wired, and already blocked while saving). */}
      <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
        <Button type="submit" isDisabled={saving || !dirty || envPending || !selectedComputerId}>
          {saving ? m.agent_profile_saving() : m.agent_profile_save_runtime_config()}
        </Button>
      </div>
    </form>
  );
}

/**
 * The Agent profile panel's Runtime config pencil target — a modal dialog, mirroring
 * `AgentRuntimeCredentialDialog` and the full page's edit dialog, rather than editing the
 * RUNTIME CONFIG section in place: the Runtime/Model/Reasoning badges never change; only the
 * pencil opens this. Closing (Esc, overlay click, Cancel, the header's X) is blocked while
 * `saving`, same as the credential dialog.
 */
export function AgentRuntimeConfigDialog({
  open,
  onClose,
  computerId,
  computers,
  computerLocked,
  credentialConfigured,
  initial,
  onLoad,
  environment,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  computerId: string;
  computers?: ReadonlyArray<AgentRuntimeComputerOption>;
  computerLocked?: boolean;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  environment?: AgentEnvironmentState;
  saving: boolean;
  error: string;
  onSave: (form: FormData, changed: { runtime: boolean; environment: boolean }) => void;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next: boolean) => {
        if (saving) return;
        if (!next) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog>
          {({ close }) => (
            <AgentRuntimeConfigForm
              computerId={computerId}
              computers={computers}
              computerLocked={computerLocked}
              credentialConfigured={credentialConfigured}
              initial={initial}
              onLoad={onLoad}
              environment={environment}
              saving={saving}
              error={error}
              onClose={close}
              onSave={onSave}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
