import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Edit01 as Edit, Plus, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { CreateWeeklyTemplateDialog } from "./create-weekly-template-dialog";
import {
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

function recipientSummary(template: WeeklyTemplateList[number]) {
  if (template.allMembers) {
    return { label: m.records_template_all_members(), more: 0 };
  }
  const names = template.recipients.map((row) => row.displayName);
  const visible = names.slice(0, 3);
  return { label: visible.join(", "), more: Math.max(0, names.length - visible.length) };
}

export function WeeklyReportSettings({
  templates,
  members,
}: {
  templates: WeeklyTemplateList;
  members: TemplateMemberOption[];
}) {
  const router = useRouter();
  const create = useServerFn(createWeeklyTemplate);
  const update = useServerFn(updateWeeklyTemplate);
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

  return (
    <>
      <PageHeader
        heading={m.records_settings()}
        leading={<BackToRecords />}
        actions={
          <Button type="button" onClick={openCreate}>
            <Plus aria-hidden="true" className="size-4" />
            {m.records_create_template()}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {templates.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {m.records_templates_empty()}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">{m.records_template_name()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_template_recipients()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_template_frequency()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_template_send_time()}</th>
                  <th className="px-4 py-3 font-semibold">{m.records_template_actions()}</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => {
                  const summary = recipientSummary(template);
                  return (
                    <tr key={template.id} className="border-t">
                      <td className="px-4 py-3 font-medium text-foreground">{template.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {summary.label}
                        {summary.more > 0
                          ? m.records_template_recipients_more({ count: summary.more })
                          : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {m.records_template_frequency_weekly()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {m.records_template_send_friday({ time: template.sendTime })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-brand"
                            disabled={busy}
                            onClick={() => openEdit(template)}
                          >
                            <Edit aria-hidden="true" className="size-4" />
                            {m.records_template_edit()}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-brand"
                            disabled={busy}
                            onClick={() => {
                              void (async () => {
                                setBusy(true);
                                try {
                                  await remove({ data: { templateId: template.id } });
                                  await router.invalidate({ sync: true });
                                } finally {
                                  setBusy(false);
                                }
                              })();
                            }}
                          >
                            <Trash aria-hidden="true" className="size-4" />
                            {m.records_template_delete()}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
