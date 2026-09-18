import { Edit01 as Edit, Plus, Trash01 as Trash, XClose as X } from "@untitledui/icons";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { m } from "@/paraglide/messages";
import { CreateWeeklyTemplateDialog } from "./create-weekly-template-dialog";
import { KeyPointPromptEditor } from "./key-point-prompt-editor";
import {
  emptyKeyPointPrompts,
  formatRecipientSummary,
  type KeyPointPromptsMeta,
} from "./records-content";
import { memberLabel, weekdayLabel, type TemplateMemberOption } from "./weekly-template-members";
import {
  applyWeeklyTemplate,
  createWeeklyTemplate,
  deleteKeyPointPromptHistory,
  deleteWeeklyTemplate,
  saveKeyPointPrompts,
  updateWeeklyTemplate,
  type loadKeyPointPrompts,
  type loadWeeklyTemplates,
} from "./records.functions";
import { BackToRecords } from "./records-layout";

export type WeeklyTemplateList = Awaited<ReturnType<typeof loadWeeklyTemplates>>;
export type KeyPointPromptsSnapshot = Awaited<ReturnType<typeof loadKeyPointPrompts>>;

export type { TemplateMemberOption };

type SettingsTopTab = "templates" | "key_points";
type KeyPointSlot = "team" | "personal";

function recipientsCell(template: WeeklyTemplateList[number]) {
  if (template.allMembers) return m.records_template_all_members();
  return formatRecipientSummary(template.recipients.map((row) => row.displayName));
}

export function WeeklyReportSettings({
  templates,
  members,
  keyPointPrompts,
  openCreateOnMount = false,
}: {
  templates: WeeklyTemplateList;
  members: TemplateMemberOption[];
  keyPointPrompts: KeyPointPromptsSnapshot;
  openCreateOnMount?: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate({ from: "/records/settings" });
  const create = useServerFn(createWeeklyTemplate);
  const update = useServerFn(updateWeeklyTemplate);
  const apply = useServerFn(applyWeeklyTemplate);
  const remove = useServerFn(deleteWeeklyTemplate);
  const savePrompts = useServerFn(saveKeyPointPrompts);
  const deleteHistory = useServerFn(deleteKeyPointPromptHistory);
  const [topTab, setTopTab] = useState<SettingsTopTab>("templates");
  const [keyPointSlot, setKeyPointSlot] = useState<KeyPointSlot>("personal");
  const initialPrompts = keyPointPrompts ?? emptyKeyPointPrompts();
  const [prompts, setPrompts] = useState<KeyPointPromptsMeta>(initialPrompts);
  const [draftText, setDraftText] = useState(initialPrompts.personal.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** True while the textarea is focused / composing — ignore loader overwrites. */
  const editingRef = useRef(false);
  /** Last text we intentionally applied from server or a successful save. */
  const appliedServerTextRef = useRef(initialPrompts.personal.text);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WeeklyTemplateList[number] | null>(null);
  const [detail, setDetail] = useState<WeeklyTemplateList[number] | null>(null);
  const [busy, setBusy] = useState(false);

  function readEditorText(): string {
    return textareaRef.current?.value ?? draftText;
  }

  function applyServerPrompts(next: KeyPointPromptsMeta, slot: KeyPointSlot = keyPointSlot) {
    const text = next[slot].text;
    setPrompts(next);
    appliedServerTextRef.current = text;
    setDraftText(text);
    if (textareaRef.current && textareaRef.current.value !== text) {
      textareaRef.current.value = text;
    }
  }

  // Sync from loader only when the user is not actively editing the field.
  useEffect(() => {
    const next = keyPointPrompts ?? emptyKeyPointPrompts();
    setPrompts(next);
    if (editingRef.current) return;
    const serverText = next[keyPointSlot].text;
    if (serverText === appliedServerTextRef.current && serverText === draftText) return;
    applyServerPrompts(next, keyPointSlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slot changes handled in selectKeyPointSlot
  }, [keyPointPrompts]);

  function selectKeyPointSlot(slot: KeyPointSlot) {
    editingRef.current = false;
    setKeyPointSlot(slot);
    applyServerPrompts(prompts, slot);
  }

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(template: WeeklyTemplateList[number]) {
    setDetail(null);
    setEditing(template);
    setDialogOpen(true);
  }

  useEffect(() => {
    if (!openCreateOnMount) return;
    setTopTab("templates");
    setEditing(null);
    setDialogOpen(true);
    void navigate({
      replace: true,
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
        create: undefined,
      }),
    });
  }, [openCreateOnMount, navigate]);

  async function toggleApplied(template: WeeklyTemplateList[number]) {
    if (busy) return;
    setBusy(true);
    try {
      await apply({ data: { templateId: template.id } });
      await router.invalidate({ sync: true });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(template: WeeklyTemplateList[number]) {
    if (busy) return;
    setBusy(true);
    try {
      await remove({ data: { templateId: template.id } });
      await router.invalidate({ sync: true });
      if (detail?.id === template.id) setDetail(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSavePrompt() {
    if (busy) return;
    // Always read the live DOM value (IME composition / last keystroke may lag React state).
    const textToSave = readEditorText();
    editingRef.current = false;
    setDraftText(textToSave);
    setBusy(true);
    try {
      const saved = await savePrompts({
        data: { slot: keyPointSlot, text: textToSave },
      });
      applyServerPrompts(saved, keyPointSlot);
      await router.invalidate({ sync: true });
      // Loader may briefly return stale data; pin the just-saved snapshot again.
      applyServerPrompts(saved, keyPointSlot);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteHistory(historyIndex: number) {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await deleteHistory({
        data: { slot: keyPointSlot, historyIndex },
      });
      setPrompts(saved);
      await router.invalidate({ sync: true });
      setPrompts(saved);
    } finally {
      setBusy(false);
    }
  }

  const activePrompt = prompts[keyPointSlot];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
        <BackToRecords />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <SettingsTabButton
            active={topTab === "templates"}
            label={m.records_settings_tab_templates()}
            onPress={() => setTopTab("templates")}
          />
          <SettingsTabButton
            active={topTab === "key_points"}
            label={m.records_settings_tab_key_points()}
            onPress={() => setTopTab("key_points")}
          />
        </div>
        {topTab === "templates" ? (
          <Button size="sm" color="primary" iconLeading={Plus} onPress={openCreate}>
            {m.records_create_template()}
          </Button>
        ) : (
          <Button size="sm" color="primary" isDisabled={busy} onPress={() => void onSavePrompt()}>
            {m.records_key_points_prompt_save()}
          </Button>
        )}
      </div>

      {topTab === "templates" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-primary p-4 sm:p-6">
          {templates.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyTitle>{m.records_templates_empty()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-secondary">
              <table className="w-full min-w-[52rem] border-collapse text-left text-sm text-primary">
                <thead>
                  <tr className="bg-secondary_subtle text-tertiary">
                    <th className="px-4 py-3 font-medium">{m.records_template_name()}</th>
                    <th className="px-4 py-3 font-medium">{m.records_template_recipients()}</th>
                    <th className="px-4 py-3 font-medium">{m.records_template_frequency()}</th>
                    <th className="px-4 py-3 font-medium">{m.records_template_send_time()}</th>
                    <th className="px-4 py-3 font-medium">{m.records_template_enabled()}</th>
                    <th className="px-4 py-3 font-medium">{m.records_template_actions()}</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((template) => (
                    <tr
                      key={template.id}
                      className="cursor-pointer border-t border-secondary hover:bg-primary_hover"
                      aria-label={`${m.records_template_open_detail()}: ${template.name}`}
                      onClick={() => setDetail(template)}
                    >
                      <td className="px-4 py-3 font-medium">{template.name}</td>
                      <td className="px-4 py-3 text-secondary">{recipientsCell(template)}</td>
                      <td className="px-4 py-3 text-secondary">
                        {m.records_template_frequency_weekly()}
                      </td>
                      <td className="px-4 py-3 text-secondary">
                        {m.records_template_send_on({
                          weekday: weekdayLabel(template.sendWeekday),
                          time: template.sendTime,
                        })}
                      </td>
                      <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                        <Button
                          size="sm"
                          color="link-gray"
                          isDisabled={busy}
                          onPress={() => void toggleApplied(template)}
                        >
                          {template.active
                            ? m.records_template_enabled_yes()
                            : m.records_template_enabled_no()}
                        </Button>
                      </td>
                      <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          <Button
                            size="sm"
                            color="link-color"
                            iconLeading={Edit}
                            isDisabled={busy}
                            onPress={() => openEdit(template)}
                          >
                            {m.records_template_edit()}
                          </Button>
                          <Button
                            size="sm"
                            color="link-destructive"
                            iconLeading={Trash}
                            isDisabled={busy}
                            onPress={() => void onDelete(template)}
                          >
                            {m.records_template_delete()}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col bg-primary">
          <div className="flex shrink-0 items-center gap-1 border-b border-secondary px-4 sm:px-8">
            <SettingsTabButton
              active={keyPointSlot === "team"}
              label={m.records_key_points_slot_team()}
              onPress={() => selectKeyPointSlot("team")}
            />
            <SettingsTabButton
              active={keyPointSlot === "personal"}
              label={m.records_key_points_slot_personal()}
              onPress={() => selectKeyPointSlot("personal")}
            />
          </div>
          <KeyPointPromptEditor
            prompt={activePrompt}
            text={draftText}
            busy={busy}
            textareaRef={textareaRef}
            onChange={(text) => {
              editingRef.current = true;
              setDraftText(text);
            }}
            onFocus={() => {
              editingRef.current = true;
            }}
            onBlur={() => {
              editingRef.current = false;
              setDraftText(readEditorText());
            }}
            onDeleteHistory={(index) => void onDeleteHistory(index)}
          />
        </div>
      )}

      <WeeklyTemplateDetailDialog
        template={detail}
        members={members}
        onClose={() => setDetail(null)}
      />

      <CreateWeeklyTemplateDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        members={members}
        initial={editing}
        onSave={async (input) => {
          setBusy(true);
          try {
            if (editing) {
              await update({ data: { templateId: editing.id, ...input } });
            } else {
              await create({ data: input });
            }
            await router.invalidate({ sync: true });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function SettingsTabButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      color="tertiary"
      aria-pressed={active}
      onPress={onPress}
      className={`-mb-px shrink-0 rounded-none px-3 py-3 ${
        active
          ? "border-b-2 border-brand text-brand-secondary"
          : "border-b-2 border-transparent text-tertiary hover:text-secondary"
      }`}
    >
      {label}
    </Button>
  );
}

function WeeklyTemplateDetailDialog({
  template,
  members,
  onClose,
}: {
  template: WeeklyTemplateList[number] | null;
  members: TemplateMemberOption[];
  onClose: () => void;
}) {
  if (!template) return null;
  const recipientNames = template.allMembers
    ? [m.records_template_all_members()]
    : template.recipients.map((row) => {
        const member = members.find((item) => item.userId === row.userId);
        return memberLabel(member ?? row);
      });

  return (
    <ModalOverlay isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal className="flex max-h-[min(90vh,40rem)] w-[calc(100vw-2rem)] max-w-lg flex-col">
        <Dialog className="flex min-h-0 flex-1 flex-col">
          {({ close }) => (
            <>
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.records_template_details()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  onClick={close}
                />
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm">
                <DetailRow label={m.records_template_name()} value={template.name} />
                {template.sections.map((section, index) => (
                  <div key={`${section.title}-${index}`} className="space-y-2">
                    <DetailRow
                      label={m.records_template_heading_level_one()}
                      value={section.title}
                    />
                    {section.children.map((child) => (
                      <DetailRow
                        key={child}
                        label={m.records_template_heading_level_two()}
                        value={child}
                        nested
                      />
                    ))}
                  </div>
                ))}
                <div className="flex gap-4">
                  <span className="w-20 shrink-0 text-tertiary">
                    {m.records_template_recipients()}
                  </span>
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {recipientNames.map((name) => (
                      <Badge key={name} size="sm" color="gray" type="modern">
                        {name}
                      </Badge>
                    ))}
                  </div>
                </div>
                <DetailRow
                  label={m.records_template_frequency()}
                  value={m.records_template_frequency_weekly()}
                />
                <DetailRow label={m.records_template_send_time()} value={template.sendTime} />
                <DetailRow
                  label={m.records_template_enabled()}
                  value={
                    template.active
                      ? m.records_template_enabled_yes()
                      : m.records_template_enabled_no()
                  }
                />
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function DetailRow({
  label,
  value,
  nested = false,
}: {
  label: string;
  value: string;
  nested?: boolean;
}) {
  return (
    <div className={`flex gap-4 ${nested ? "pl-6" : ""}`}>
      <span className="w-20 shrink-0 text-tertiary">{label}</span>
      <span className="min-w-0 text-primary">{value}</span>
    </div>
  );
}
