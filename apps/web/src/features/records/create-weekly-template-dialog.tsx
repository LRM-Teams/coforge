import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Plus, XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Select } from "@/components/base/select/select";
import { cn } from "@/lib/utils";
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
  const nameId = useId();
  const dimensionId = useId();
  const titleId = useId();
  const editing = Boolean(initial);
  const [name, setName] = useState("");
  const [dimensionDraft, setDimensionDraft] = useState("");
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [mainTitles, setMainTitles] = useState<string[]>([]);
  const [allMembers, setAllMembers] = useState(false);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
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
    setRecipientsOpen(false);
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
    setRecipientsOpen(false);
    setRecipientQuery("");
    setSendTime(template.sendTime || "15:00");
    setNameError(false);
    setSaving(false);
  }

  useEffect(() => {
    if (!open) return;
    applyInitial(initial);
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
      onOpenChange={(value: boolean) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <Modal className="flex max-h-[min(90vh,44rem)] w-[calc(100vw-2rem)] max-w-xl flex-col overflow-hidden">
        <Dialog>
          <div className="flex items-center justify-between border-b border-secondary px-6 py-4">
            <Heading slot="title" className="text-lg font-semibold text-primary">
              {editing ? m.records_edit_template() : m.records_create_template()}
            </Heading>
            <ButtonUtility
              type="button"
              aria-label={m.controls_close()}
              icon={X}
              size="sm"
              color="tertiary"
              onClick={() => onOpenChange(false)}
            />
          </div>

          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <Field label={m.records_template_name()} htmlFor={nameId}>
                <input
                  id={nameId}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameError(false);
                  }}
                  placeholder={m.records_template_name_placeholder()}
                  className={fieldInputClassName}
                />
                <p className={cn("text-xs text-tertiary", nameError && "text-error-primary")}>
                  {m.records_template_name_hint()}
                </p>
              </Field>

              <Field label={m.records_template_dimension()} htmlFor={dimensionId}>
                <div className="flex gap-2">
                  <input
                    id={dimensionId}
                    value={dimensionDraft}
                    onChange={(event) => setDimensionDraft(event.target.value)}
                    placeholder={m.records_template_dimension_placeholder()}
                    className={cn(fieldInputClassName, "flex-1")}
                  />
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    aria-label={m.records_template_add_dimension()}
                    onPress={addDimension}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </div>
              </Field>

              <Field label={m.records_template_select_dimension()}>
                <div className="min-h-20 rounded-lg bg-secondary px-3 py-2 ring-1 ring-secondary ring-inset">
                  {dimensions.length === 0 ? (
                    <span className="text-sm text-tertiary">
                      {m.records_template_select_dimension()}
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {dimensions.map((item) => (
                        <span
                          key={item}
                          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium ring-1 ring-secondary"
                        >
                          {item}
                          <Button
                            type="button"
                            color="tertiary"
                            size="sm"
                            className="size-5 text-tertiary"
                            aria-label={`${m.records_template_delete()}: ${item}`}
                            onPress={() =>
                              setDimensions((current) => current.filter((value) => value !== item))
                            }
                          >
                            <X className="size-3" />
                          </Button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Field>

              <Field label={m.records_template_main_title()} htmlFor={titleId}>
                <div className="flex gap-2">
                  <input
                    id={titleId}
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    placeholder={m.records_template_main_title_placeholder()}
                    className={cn(fieldInputClassName, "flex-1")}
                  />
                  <Button
                    type="button"
                    color="secondary"
                    size="sm"
                    aria-label={m.records_template_add_title()}
                    onPress={addMainTitle}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </div>
                {mainTitles.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {mainTitles.map((item) => (
                      <span
                        key={item}
                        className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs font-medium"
                      >
                        {item}
                        <Button
                          type="button"
                          color="tertiary"
                          size="sm"
                          className="size-5 text-tertiary"
                          aria-label={`${m.records_template_delete()}: ${item}`}
                          onPress={() =>
                            setMainTitles((current) => current.filter((value) => value !== item))
                          }
                        >
                          <X className="size-3" />
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>

              <Field label={m.records_template_recipients()}>
                <div className="relative">
                  <Button
                    type="button"
                    color="secondary"
                    className="h-10 w-full justify-start font-normal"
                    onPress={() => setRecipientsOpen((open) => !open)}
                  >
                    <span className={cn("truncate", !recipientLabel && "text-tertiary")}>
                      {recipientLabel || m.records_template_recipients_placeholder()}
                    </span>
                  </Button>
                  {recipientsOpen && (
                    <div className="absolute top-full right-0 left-0 z-20 mt-2 overflow-hidden rounded-lg border border-secondary bg-primary shadow-lg">
                      <div className="border-b border-secondary px-3 py-2 text-sm font-medium">
                        {m.records_template_recipients_title()}
                      </div>
                      <div className="border-b border-secondary px-3 py-2">
                        <input
                          type="search"
                          value={recipientQuery}
                          onChange={(event) => setRecipientQuery(event.target.value)}
                          placeholder={m.records_search_placeholder()}
                          className="h-9 w-full rounded-md bg-secondary px-3 text-sm outline-none ring-1 ring-secondary ring-inset focus:ring-2 focus:ring-brand"
                        />
                      </div>
                      <ul className="max-h-56 overflow-y-auto p-1">
                        <RecipientOption
                          checked={allMembers}
                          label={m.records_template_all_members()}
                          onToggle={() => toggleRecipient("all")}
                        />
                        {filteredMembers.map((member) => {
                          const label = member.displayName ?? member.username;
                          return (
                            <RecipientOption
                              key={member.userId}
                              checked={allMembers || recipientIds.includes(member.userId)}
                              label={`${label}${member.role ? ` - ${member.role}` : ""}`}
                              person={{ name: label }}
                              onToggle={() => toggleRecipient(member.userId)}
                            />
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={m.records_template_frequency()}>
                  <Select
                    size="sm"
                    aria-label={m.records_template_frequency()}
                    selectedKey={frequency}
                    onSelectionChange={() => {}}
                  >
                    <Select.Item id="weekly" label={m.records_template_frequency_weekly()} />
                  </Select>
                </Field>
                <Field label={m.records_template_send_time()}>
                  <Select
                    size="sm"
                    aria-label={m.records_template_send_time()}
                    selectedKey={sendTime}
                    onSelectionChange={(key) => setSendTime(key ? String(key) : "15:00")}
                  >
                    {SEND_TIMES.map((time) => (
                      <Select.Item key={time} id={time} label={time} />
                    ))}
                  </Select>
                </Field>
              </div>
            </div>

            <div className="flex justify-center gap-3 border-t border-secondary px-6 py-4">
              <Button type="submit" isDisabled={saving}>
                {m.records_template_save()}
              </Button>
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
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function RecipientOption({
  checked,
  label,
  person,
  onToggle,
}: {
  checked: boolean;
  label: string;
  person?: { name: string };
  onToggle: () => void;
}) {
  return (
    <li>
      <Button
        type="button"
        color="tertiary"
        aria-pressed={checked}
        onPress={onToggle}
        className="h-auto w-full justify-start gap-2 px-2 py-2 font-normal"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded border",
            checked ? "border-brand bg-brand-solid text-white" : "border-secondary bg-primary",
          )}
        >
          {checked ? "✓" : null}
        </span>
        {person ? (
          <Avatar
            size="xs"
            alt={person.name}
            initials={avatarInitial(person.name)}
            contentClassName={avatarToneClassName(person.name)}
          />
        ) : null}
        <span className="truncate text-sm">{label}</span>
      </Button>
    </li>
  );
}

const fieldInputClassName =
  "h-10 w-full rounded-lg bg-primary px-3 text-sm shadow-xs ring-1 ring-secondary outline-none ring-inset focus:ring-2 focus:ring-brand";
