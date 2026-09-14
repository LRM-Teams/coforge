import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type FormEvent,
  type Key,
  type ReactNode,
} from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import { isValidTemplateName } from "./records-content";
import { parseTemplateSections, type TemplateOutlineSection } from "./template-outline-sections";
import type { TemplateMemberOption, WeeklyTemplateList } from "./weekly-report-settings";

const SEND_TIMES = ["09:00", "12:00", "15:00", "18:00"] as const;
const SEND_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function weekdayLabel(day: number) {
  switch (day) {
    case 1:
      return m.records_template_weekday_mon();
    case 2:
      return m.records_template_weekday_tue();
    case 3:
      return m.records_template_weekday_wed();
    case 4:
      return m.records_template_weekday_thu();
    case 5:
      return m.records_template_weekday_fri();
    case 6:
      return m.records_template_weekday_sat();
    default:
      return m.records_template_weekday_sun();
  }
}

function emptySection(): TemplateOutlineSection {
  return { title: "", children: [] };
}

export type CreateWeeklyTemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  sections: TemplateOutlineSection[];
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
  const [sections, setSections] = useState<TemplateOutlineSection[]>([emptySection()]);
  const [allMembers, setAllMembers] = useState(false);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [frequency] = useState<"weekly">("weekly");
  const [sendTime, setSendTime] = useState<string>("15:00");
  const [sendWeekday, setSendWeekday] = useState(5);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
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
    setSections([emptySection()]);
    setAllMembers(false);
    setRecipientIds([]);
    setRecipientQuery("");
    setSendTime("15:00");
    setSendWeekday(5);
    setScheduleEnabled(false);
    setNameError(false);
    setSaving(false);
  }

  function applyInitial(template: WeeklyTemplateDraft | null | undefined) {
    if (!template) {
      reset();
      return;
    }
    setName(template.name);
    const parsed = parseTemplateSections(template.sections ?? template.dimensions);
    setSections(parsed.length > 0 ? parsed : [emptySection()]);
    setAllMembers(template.allMembers);
    setRecipientIds(template.allMembers ? [] : template.recipients.map((row) => row.userId));
    setRecipientQuery("");
    setSendTime(template.sendTime || "15:00");
    setSendWeekday(template.sendWeekday || 5);
    setScheduleEnabled(Boolean(template.scheduleEnabled));
    setNameError(false);
    setSaving(false);
  }

  const resetDraft = useEffectEvent(() => applyInitial(initial));
  const initialId = initial?.id;
  useEffect(() => {
    if (open) resetDraft();
  }, [open, initialId]);

  function updateSectionTitle(index: number, title: string) {
    setSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, title } : section,
      ),
    );
  }

  function updateChildTitle(sectionIndex: number, childIndex: number, title: string) {
    setSections((current) =>
      current.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          children: section.children.map((child, offset) =>
            offset === childIndex ? title : child,
          ),
        };
      }),
    );
  }

  function addSection() {
    setSections((current) => [...current, emptySection()]);
  }

  function removeSection(index: number) {
    setSections((current) => {
      const next = current.filter((_, sectionIndex) => sectionIndex !== index);
      return next.length > 0 ? next : [emptySection()];
    });
  }

  function addChild(sectionIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex ? { ...section, children: [...section.children, ""] } : section,
      ),
    );
  }

  function removeChild(sectionIndex: number, childIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              children: section.children.filter((_, offset) => offset !== childIndex),
            }
          : section,
      ),
    );
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
    const normalizedSections = sections
      .map((section) => ({
        title: section.title.trim(),
        children: section.children.map((child) => child.trim()).filter(Boolean),
      }))
      .filter((section) => section.title.length > 0);
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        frequency,
        sendTime,
        sendWeekday,
        scheduleEnabled,
        sections: normalizedSections,
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
                  <p className="text-sm font-semibold text-primary">
                    {m.records_template_details()}
                  </p>

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

                  <div className="space-y-3">
                    {sections.map((section, sectionIndex) => (
                      <div key={sectionIndex} className="space-y-2">
                        <OutlineRow
                          label={m.records_template_heading_level_one()}
                          value={section.title}
                          onChange={(value) => updateSectionTitle(sectionIndex, value)}
                          onRemove={() => removeSection(sectionIndex)}
                          removeLabel={m.records_template_delete_heading()}
                        />
                        {section.children.length > 0 ? (
                          <div className="relative ml-3 space-y-2 border-l-2 border-secondary pl-4">
                            {section.children.map((child, childIndex) => (
                              <OutlineRow
                                key={`${sectionIndex}-${childIndex}`}
                                label={m.records_template_heading_level_two()}
                                value={child}
                                onChange={(value) =>
                                  updateChildTitle(sectionIndex, childIndex, value)
                                }
                                onRemove={() => removeChild(sectionIndex, childIndex)}
                                removeLabel={m.records_template_delete_heading()}
                              />
                            ))}
                          </div>
                        ) : null}
                        <div className="pl-1">
                          <Button
                            type="button"
                            size="sm"
                            color="link-gray"
                            onPress={() => addChild(sectionIndex)}
                          >
                            {m.records_template_add_heading_level_two()}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button type="button" size="sm" color="secondary" onPress={addSection}>
                      {m.records_template_add_heading_level_one()}
                    </Button>
                  </div>

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
                      label={m.records_template_send_weekday()}
                      size="sm"
                      selectedKey={String(sendWeekday)}
                      onSelectionChange={(key) => setSendWeekday(key ? Number(key) : 5)}
                      hideRequiredIndicator
                    >
                      {SEND_WEEKDAYS.map((day) => (
                        <Select.Item key={day} id={String(day)} label={weekdayLabel(day)} />
                      ))}
                    </Select>
                  </div>

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

                  <Checkbox
                    size="sm"
                    isSelected={scheduleEnabled}
                    onChange={setScheduleEnabled}
                    label={m.records_template_schedule_enabled()}
                    hint={m.records_template_schedule_enabled_hint()}
                  />
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

function OutlineRow({
  label,
  value,
  onChange,
  onRemove,
  removeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-sm text-tertiary">{label}</span>
      <Input className="min-w-0 flex-1" value={value} onChange={onChange} />
      <ButtonUtility
        size="sm"
        color="tertiary"
        icon={X}
        aria-label={removeLabel}
        onClick={onRemove}
      />
    </div>
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
