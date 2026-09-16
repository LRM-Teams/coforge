import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Edit01 as Edit, Plus, Trash01 as Trash, XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Tabs } from "@/components/application/tabs/tabs";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { m } from "@/paraglide/messages";
import { CreateWeeklyTemplateDialog } from "./create-weekly-template-dialog";
import { formatRecipientSummary } from "./records-content";
import { memberLabel, weekdayLabel, type TemplateMemberOption } from "./weekly-template-members";
import {
  applyWeeklyTemplate,
  createWeeklyTemplate,
  deleteWeeklyTemplate,
  updateWeeklyTemplate,
  type loadWeeklyTemplates,
} from "./records.functions";
import { BackToRecords } from "./records-layout";

export type WeeklyTemplateList = Awaited<ReturnType<typeof loadWeeklyTemplates>>;

export type { TemplateMemberOption };

function recipientsCell(template: WeeklyTemplateList[number]) {
  if (template.allMembers) return m.records_template_all_members();
  return formatRecipientSummary(template.recipients.map((row) => row.displayName));
}

export function WeeklyReportSettings({
  templates,
  members,
  openCreateOnMount = false,
}: {
  templates: WeeklyTemplateList;
  members: TemplateMemberOption[];
  openCreateOnMount?: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate({ from: "/records/settings" });
  const create = useServerFn(createWeeklyTemplate);
  const update = useServerFn(updateWeeklyTemplate);
  const apply = useServerFn(applyWeeklyTemplate);
  const remove = useServerFn(deleteWeeklyTemplate);
  const [settingsTab, setSettingsTab] = useState<"weekly" | "highlights">("weekly");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WeeklyTemplateList[number] | null>(null);
  const [detail, setDetail] = useState<WeeklyTemplateList[number] | null>(null);
  const [busy, setBusy] = useState(false);

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
    setEditing(null);
    setDialogOpen(true);
    void navigate({
      replace: true,
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
        <BackToRecords />
        <Tabs
          selectedKey={settingsTab}
          onSelectionChange={(key) =>
            setSettingsTab(key === "highlights" ? "highlights" : "weekly")
          }
          className="min-w-0 flex-1"
        >
          <Tabs.List type="underline" size="sm">
            <Tabs.Item id="weekly" label={m.records_parent_tab_template()} />
            <Tabs.Item id="highlights" label={m.records_settings_tab_highlights()} />
          </Tabs.List>
        </Tabs>
        {settingsTab === "weekly" ? (
          <Button size="sm" color="primary" iconLeading={Plus} onPress={openCreate}>
            {m.records_create_template()}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-primary p-4 sm:p-6">
        {settingsTab === "highlights" ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{m.records_highlight_templates_empty()}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : templates.length === 0 ? (
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
