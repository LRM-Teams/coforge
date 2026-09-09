import { BellRinging01 as BellRing } from "@untitledui/icons";
import { RelativeTime } from "@/components/ui/relative-time";

export type ReminderNoticeView = {
  id: string;
  type: "created" | "fired";
  title: string;
  time: Date | string;
  nextFireAt: Date | string | null;
  ownerAgentName: string;
  messageId: string;
  threadRootId?: string;
};

export function ReminderNotice({ notice }: { notice: ReminderNoticeView }) {
  return (
    <li
      data-reminder-notice={notice.type}
      className="flex items-start gap-3 rounded-lg border border-secondary bg-secondary px-3 py-2.5 text-sm"
    >
      <BellRing aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-semibold tracking-wide text-tertiary">
            SYSTEM REMINDER
          </span>
          <span aria-hidden="true" className="text-tertiary">
            ·
          </span>
          <span className="font-medium">
            {notice.type === "created" ? "Reminder scheduled" : "Reminder fired"}
          </span>
          <span aria-hidden="true" className="text-tertiary">
            ·
          </span>
          <RelativeTime value={notice.time} className="text-xs text-tertiary" />
        </p>
        <p className="mt-1 [overflow-wrap:anywhere]">{notice.title}</p>
        <p className="mt-1 text-xs text-tertiary">
          <span>{notice.ownerAgentName}</span>
          {notice.type === "created" && notice.nextFireAt ? (
            <>
              {" · Due "}
              <RelativeTime value={notice.nextFireAt} />
            </>
          ) : null}
          {" · "}
          <a className="text-brand-secondary underline" href={`#message-${notice.messageId}`}>
            View original message
          </a>
        </p>
      </div>
    </li>
  );
}
