import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHANNEL_NAME_PATTERN } from "@lrm/coforge-sdk/internal";
import { XClose } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  projects = [],
  defaultName = "",
  initialMembers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (
    name: string,
    projectId?: string,
    memberUserIds?: string[],
    memberAgentIds?: string[],
  ) => Promise<void>;
  projects?: { id: string; name: string; slug: string }[];
  /** Prefills, but does not force, the channel name — e.g. the project slug when
   * creating a project's first discussion group. */
  defaultName?: string;
  /** An Agent-prepared `channel:create` action card's initial humans/Agents: shown as
   * preselected, individually deselectable checkboxes. */
  initialMembers?: {
    humans: { id: string; displayName: string }[];
    agents: { id: string; displayName: string }[];
  };
}) {
  const [name, setName] = useState(defaultName);
  const [projectId, setProjectId] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    () => new Set(initialMembers?.humans.map((human) => human.id)),
  );
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(initialMembers?.agents.map((agent) => agent.id)),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setProjectId("");
    setSelectedUserIds(new Set(initialMembers?.humans.map((human) => human.id)));
    setSelectedAgentIds(new Set(initialMembers?.agents.map((agent) => agent.id)));
    setError("");
    // Only the dialog's opening transition re-seeds selection; toggling checkboxes afterwards
    // must not be overwritten by `initialMembers` identity changes while it stays open.
  }, [open, defaultName]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(
        name.trim(),
        projectId || undefined,
        [...selectedUserIds],
        [...selectedAgentIds],
      );
      setName("");
      setProjectId("");
      onOpenChange(false);
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "CONFLICT" ? m.channel_conflict() : m.channel_error(),
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (!busy.current) onOpenChange(value);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={XClose}
                size="sm"
                color="tertiary"
                className="absolute top-4 right-4"
                onClick={close}
              />
              <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
                {m.channel_create()}
              </Heading>
              <Text slot="description" className="mt-2 block text-sm text-tertiary">
                {m.channel_public_description()}
              </Text>
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
                <Input
                  label={m.channel_name()}
                  hint={m.channel_name_hint()}
                  value={name}
                  onChange={setName}
                  isRequired
                  maxLength={32}
                  pattern="[a-z0-9][a-z0-9_\-]{0,31}"
                  placeholder="engineering"
                  isDisabled={saving}
                />
                {projects.length > 0 && (
                  <Select
                    aria-label="Project"
                    placeholder="No Project"
                    selectedKey={projectId || null}
                    onSelectionChange={(key) => setProjectId(String(key))}
                    isDisabled={saving}
                  >
                    {projects.map((project) => (
                      <Select.Item
                        key={project.id}
                        id={project.id}
                        label={`${project.name} (${project.slug})`}
                      />
                    ))}
                  </Select>
                )}
                {initialMembers &&
                  (initialMembers.humans.length > 0 || initialMembers.agents.length > 0) && (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-xs font-medium text-tertiary">
                        {m.action_card_initial_members()}
                      </p>
                      {[...initialMembers.humans, ...initialMembers.agents].map((member) => {
                        const isAgent = initialMembers.agents.some(
                          (agent) => agent.id === member.id,
                        );
                        const selected = isAgent
                          ? selectedAgentIds.has(member.id)
                          : selectedUserIds.has(member.id);
                        return (
                          <Checkbox
                            key={member.id}
                            label={`@${member.displayName}`}
                            isDisabled={saving}
                            isSelected={selected}
                            onChange={(next) =>
                              (isAgent ? setSelectedAgentIds : setSelectedUserIds)((previous) => {
                                const set = new Set(previous);
                                if (next) set.add(member.id);
                                else set.delete(member.id);
                                return set;
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  isDisabled={saving || !CHANNEL_NAME_PATTERN.test(name.trim())}
                  className="mt-4 w-full"
                >
                  {m.channel_create()}
                </Button>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
