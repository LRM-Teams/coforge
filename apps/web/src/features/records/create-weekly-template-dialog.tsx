import { useEffect, useMemo, useState, type FormEvent, type Key, type ReactNode } from "react";
import { Plus, XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { BadgeWithButton } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import { isValidTemplateName } from "./records-content";
import type { TemplateMemberOption, WeeklyTemplateList } from "./weekly-report-settings";

const SEND_TIMES = ["09:00", "12:00", "15:00", "18:00"] as const;

export type CreateWeeklyTemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  dimensions: string[];
  mainTitles: string[];
  allMembers: boolean;
  recipientUserIds: string[];
};

export type WeeklyTemplateDraft = WeeklyTemplateList[number];

export function CreateWeeklyTemplateDialog({
  open,
  onOpenChange,
  onSave,
  members,
  initial = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (template: CreateWeeklyTemplateInput) => void | Promise<void>;
  members: TemplateMemberOption[];
  initial?: WeeklyTemplateDraft | null;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState("");
  const [dimensionDraft, setDimensionDraft] = useState("");
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [mainTitles, setMainTitles] = useState<string[]>([]);
  const [allMembers, setAllMembers] = useState(false);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [frequency] = useState<"weekly">("weekly");
  const [sendTime, setSendTime] = useState<string>("15:00");
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);

  const filteredMembers = useMemo(() => {
    const query = recipientQuery.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) => {
      const display = (member.displayName ?? member.username).toLowerCase();
      const role = (member.role ?? "").toLowerCase();
      return (
        display.includes(query) ||
        member.username.toLowerCase().includes(query) ||
        role.includes(query)
      );
    });
  }, [recipientQuery, members]);

  function reset() {
    setName("");
    setDimensionDraft("");
    setDimensions([]);
    setTitleDraft("");
    setMainTitles([]);
    setAllMembers(false);
    setRecipientIds([]);
    setRecipientQuery("");
    setSendTime("15:00");
    setNameError(false);
    setSaving(false);
  }

  function applyInitial(template: WeeklyTemplateDraft | null | undefined) {
    if (!template) {
      reset();
      return;
    }
    setName(template.name);
    setDimensionDraft("");
    setDimensions([...template.dimensions]);
    setTitleDraft("");
    setMainTitles([...template.mainTitles]);
    setAllMembers(template.allMembers);
    setRecipientIds(template.allMembers ? [] : template.recipients.map((row) => row.userId));
    setRecipientQuery("");
    setSendTime(template.sendTime || "15:00");
    setNameError(false);
    setSaving(false);
  }

  useEffect(() => {
    if (!open) return;
    applyInitial(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id]);

  function addDimension() {
    const value = dimensionDraft.trim();
    if (!value || dimensions.includes(value)) return;
    setDimensions((current) => [...current, value]);
    setDimensionDraft("");
  }

  function addMainTitle() {
    const value = titleDraft.trim();
    if (!value || mainTitles.includes(value)) return;
    setMainTitles((current) => [...current, value]);
    setTitleDraft("");
  }

  function toggleRecipient(userId: string | "all") {
    if (userId === "all") {
      setAllMembers((current) => !current);
      setRecipientIds([]);
      return;
    }
    setAllMembers(false);
    setRecipientIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  }

  function onRecipientSelectionChange(keys: "all" | Set<Key>) {
    if (keys === "all") return;
    const previous = allMembers ? new Set<Key>(["all"]) : new Set<Key>(recipientIds);
    const changed =
      [...keys].find((key) => !previous.has(key)) ?? [...previous].find((key) => !keys.has(key));
    if (changed !== undefined) toggleRecipient(changed === "all" ? "all" : String(changed));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTemplateName(name)) {
      setNameError(true);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        frequency,
        sendTime,
        dimensions,
        mainTitles,
        allMembers: allMembers || recipientIds.length === 0,
        recipientUserIds: allMembers ? [] : recipientIds,
      });
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  const recipientLabel = (() => {
    if (allMembers) return m.records_template_all_members();
    if (recipientIds.length === 0) return "";
    return recipientIds
      .map((id) => {
        const member = members.find((row) => row.userId === id);
        return member?.displayName ?? member?.username;
      })
      .filter(Boolean)
      .join(", ");
  })();

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <Modal className="flex max-h-[min(90vh,44rem)] w-[calc(100vw-2rem)] max-w-xl flex-col">
        <Dialog className="flex min-h-0 flex-1 flex-col">
          {({ close }) => (
            <>
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {editing ? m.records_edit_template() : m.records_create_template()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  onClick={close}
                />
              </div>

              <form
                onSubmit={(event) => void submit(event)}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
                  <Input
                    label={m.records_template_name()}
                    value={name}
                    hideRequiredIndicator
                    onChange={(value) => {
                      setName(value);
                      setNameError(false);
                    }}
                    placeholder={m.records_template_name_placeholder()}
                    isInvalid={nameError}
                    hint={m.records_template_name_hint()}
                  />

                  <Field label={m.records_template_dimension()}>
                    <div className="flex gap-2">
                      <Input
                        className="flex-1"
                        value={dimensionDraft}
                        onChange={setDimensionDraft}
                        placeholder={m.records_template_dimension_placeholder()}
                      />
                      <ButtonUtility
                        color="secondary"
                        icon={Plus}
                        aria-label={m.records_template_add_dimension()}
                        onClick={addDimension}
                      />
                    </div>
                    {dimensions.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {dimensions.map((item) => (
                          <BadgeWithButton
                            key={item}
                            type="color"
                            color="gray"
                            buttonLabel={`${m.records_template_delete()}: ${item}`}
                            onButtonClick={() =>
                              setDimensions((current) => current.filter((value) => value !== item))
                            }
                          >
                            {item}
                          </BadgeWithButton>
                        ))}
                      </div>
                    )}
                  </Field>

                  <Field label={m.records_template_main_title()}>
                    <div className="flex gap-2">
                      <Input
                        className="flex-1"
                        value={titleDraft}
                        onChange={setTitleDraft}
                        placeholder={m.records_template_main_title_placeholder()}
                      />
                      <ButtonUtility
                        color="secondary"
                        icon={Plus}
                        aria-label={m.records_template_add_title()}
                        onClick={addMainTitle}
                      />
                    </div>
                    {mainTitles.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-2">
                        {mainTitles.map((item) => (
                          <BadgeWithButton
                            key={item}
                            type="color"
                            color="gray"
                            buttonLabel={`${m.records_template_delete()}: ${item}`}
                            onButtonClick={() =>
                              setMainTitles((current) => current.filter((value) => value !== item))
                            }
                          >
                            {item}
                          </BadgeWithButton>
                        ))}
                      </div>
                    )}
                  </Field>

                  <Field label={m.records_template_recipients()}>
                    <Dropdown.Root>
                      <Button
                        type="button"
                        color="secondary"
                        className="w-full justify-start font-normal"
                      >
                        <span className={recipientLabel ? "truncate" : "truncate text-placeholder"}>
                          {recipientLabel || m.records_template_recipients_placeholder()}
                        </span>
                      </Button>
                      <Dropdown.Popover placement="bottom start" className="w-80">
                        <div className="border-b border-secondary p-2">
                          <Input
                            size="sm"
                            type="search"
                            value={recipientQuery}
                            onChange={setRecipientQuery}
                            placeholder={m.records_search_placeholder()}
                          />
                        </div>
                        <Dropdown.Menu
                          aria-label={m.records_template_recipients_title()}
                          selectionMode="multiple"
                          selectedKeys={allMembers ? new Set(["all"]) : new Set(recipientIds)}
                          onSelectionChange={onRecipientSelectionChange}
                          className="max-h-64 overflow-y-auto"
                        >
                          <Dropdown.Item
                            id="all"
                            label={m.records_template_all_members()}
                            selectionIndicator="checkbox"
                          />
                          {filteredMembers.map((member) => (
                            <Dropdown.Item
                              key={member.userId}
                              id={member.userId}
                              label={`${member.displayName ?? member.username}${member.role ? ` · ${member.role}` : ""}`}
                              selectionIndicator="checkbox"
                            />
                          ))}
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    </Dropdown.Root>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      label={m.records_template_frequency()}
                      size="sm"
                      selectedKey={frequency}
                      onSelectionChange={() => {}}
                      hideRequiredIndicator
                    >
                      <Select.Item id="weekly" label={m.records_template_frequency_weekly()} />
                    </Select>
                    <Select
                      label={m.records_template_send_time()}
                      size="sm"
                      selectedKey={sendTime}
                      onSelectionChange={(key) => setSendTime(key ? String(key) : "15:00")}
                      hideRequiredIndicator
                    >
                      {SEND_TIMES.map((time) => (
                        <Select.Item key={time} id={time} label={time} />
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 border-t border-secondary px-6 py-4">
                  <Button
                    type="button"
                    color="secondary"
                    isDisabled={saving}
                    onPress={() => {
                      reset();
                      onOpenChange(false);
                    }}
                  >
                    {m.records_template_cancel()}
                  </Button>
                  <Button type="submit" isDisabled={saving}>
                    {m.records_template_save()}
                  </Button>
                </div>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-secondary">{label}</span>
      {children}
    </div>
  );
}
