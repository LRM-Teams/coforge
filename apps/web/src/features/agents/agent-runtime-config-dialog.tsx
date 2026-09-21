import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Trash01 } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { m } from "@/paraglide/messages";
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

type EnvironmentRow = { key: string; value: string };

/**
 * The RUNTIME CONFIG pencil's form body: the same `AgentRuntimeFields` as the full page's edit
 * dialog, plus Save/Cancel and an inline error line. Kept as its own plain component (no
 * `Modal`/`Dialog`) so it renders outside a browser DOM — `Modal` needs a portal target
 * `renderToStaticMarkup` cannot provide (verified: it renders empty, no thrown error), so
 * `agent-runtime-config-dialog.test.tsx` renders this piece directly instead of the dialog shell.
 * Save stays disabled until `AgentRuntimeFields` reports an actual change via `onDirtyChange`, or
 * until the Advanced env rows differ from their loaded starting point.
 */
export function AgentRuntimeConfigForm({
  computerId,
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
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [envRows, setEnvRows] = useState<EnvironmentRow[]>([]);
  const seeded = useRef(false);
  useEffect(() => {
    if (!environment?.loaded || seeded.current) return;
    seeded.current = true;
    setEnvRows(Object.entries(environment.values).map(([key, value]) => ({ key, value })));
  }, [environment]);

  const envDirty = agentEnvironmentRowsChanged(envRows, environment?.values ?? {});
  const dirty = runtimeDirty || envDirty;
  const envPending = environment !== undefined && !environment.loaded;

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave(new FormData(event.currentTarget), { runtime: runtimeDirty, environment: envDirty });
      }}
    >
      <DialogHeader title={m.agent_profile_edit_runtime_config()} onClose={onClose} />
      <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
        <AgentRuntimeFields
          open
          computerId={computerId}
          credentialConfigured={credentialConfigured}
          initial={initial}
          onLoad={onLoad}
          onDirtyChange={setRuntimeDirty}
        />
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
      <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
        <Button type="button" color="secondary" isDisabled={saving} onPress={onClose}>
          {m.controls_cancel()}
        </Button>
        <Button type="submit" isDisabled={saving || !dirty || envPending}>
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
