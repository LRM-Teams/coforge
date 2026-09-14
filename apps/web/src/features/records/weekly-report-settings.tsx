import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { DotsHorizontal, Edit01 as Edit, Plus, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { m } from "@/paraglide/messages";
import { CreateWeeklyTemplateDialog } from "./create-weekly-template-dialog";
import {
  applyWeeklyTemplate,
  createWeeklyTemplate,
  deleteWeeklyTemplate,
  updateWeeklyTemplate,
  type loadWeeklyTemplates,
} from "./records.functions";
import { BackToRecords } from "./records-layout";

export type WeeklyTemplateList = Awaited<ReturnType<typeof loadWeeklyTemplates>>;

export type TemplateMemberOption = {
  userId: string;
  username: string;
  displayName: string | null;
  role?: string;
};

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

function recipientSummary(template: WeeklyTemplateList[number]) {
  if (template.allMembers) {
    return { label: m.records_template_all_members(), more: 0 };
  }
  const names = template.recipients.map((row) => row.displayName);
  const visible = names.slice(0, 3);
  return {
    label: visible.join(", "),
    more: Math.max(0, names.length - visible.length),
  };
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WeeklyTemplateList[number] | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(template: WeeklyTemplateList[number]) {
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

  return (
    <>
      <PageHeader
        heading={m.records_settings()}
        leading={<BackToRecords />}
        actions={
          <Button size="sm" color="secondary" iconLeading={Plus} onPress={openCreate}>
            {m.records_create_template()}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto bg-primary">
        {templates.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{m.records_templates_empty()}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y divide-secondary">
            {templates.map((template) => {
              const summary = recipientSummary(template);
              return (
                <li
                  key={template.id}
                  className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 sm:gap-4 sm:px-8"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium text-primary">{template.name}</p>
                      {template.active ? (
                        <span className="shrink-0 rounded-full bg-brand-primary px-2 py-0.5 text-xs font-medium text-brand-secondary">
                          {m.records_template_applied()}
                        </span>
                      ) : null}
                      {template.scheduleEnabled ? (
                        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-tertiary">
                          {m.records_template_schedule_badge()}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-tertiary">
                      {summary.label}
                      {summary.more > 0
                        ? m.records_template_recipients_more({
                            count: summary.more,
                          })
                        : null}
                      {" · "}
                      {m.records_template_frequency_weekly()}
                      {" · "}
                      {m.records_template_send_on({
                        weekday: weekdayLabel(template.sendWeekday),
                        time: template.sendTime,
                      })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={busy}
                    onPress={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          await apply({ data: { templateId: template.id } });
                          await router.invalidate({ sync: true });
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    {template.active ? m.records_template_unapply() : m.records_template_apply()}
                  </Button>
                  <Dropdown.Root>
                    <ButtonUtility
                      size="sm"
                      color="tertiary"
                      icon={DotsHorizontal}
                      isDisabled={busy}
                      aria-label={`${m.records_template_actions()}: ${template.name}`}
                    />
                    <Dropdown.Popover placement="bottom end" className="w-40">
                      <Dropdown.Menu
                        onAction={(key) => {
                          if (key === "edit") openEdit(template);
                          if (key === "delete") {
                            void (async () => {
                              setBusy(true);
                              try {
                                await remove({
                                  data: { templateId: template.id },
                                });
                                await router.invalidate({ sync: true });
                              } finally {
                                setBusy(false);
                              }
                            })();
                          }
                        }}
                      >
                        <Dropdown.Item id="edit" icon={Edit} label={m.records_template_edit()} />
                        <Dropdown.Item
                          id="delete"
                          icon={Trash}
                          label={m.records_template_delete()}
                        />
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown.Root>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
    </>
  );
}
