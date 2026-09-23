import { RefreshCw01 as RefreshCw, ChevronDown } from "@untitledui/icons";
import { Disclosure, DisclosurePanel } from "react-aria-components";
import { type RefObject } from "react";

import { type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { Button } from "@/components/base/buttons/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";

/** Read-only alias for the popover body's `data` shape, re-declared from the hook's return so a
 * test can render this component directly with a plain fixture (no React Query). */
export type AgentContextPopoverData = {
  state: "fresh" | "stale" | "missing";
  result?: {
    scanId: string;
    status: string;
    message?: string;
    report?: {
      provider: RuntimeProvider;
      model?: string;
      usedTokens: number;
      windowTokens: number;
      observedAt: string;
      categories: { name: string; tokens: number; approximate?: boolean }[];
      memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
      skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
    };
    collectedAt: string;
  };
  pendingScanId?: string;
};

/** The categorical swatches for the stacked bar and table dots (`bg-avatar-1..6`, `lib/
 * avatar-tone.ts`'s palette), plus a neutral for Free space. No red/amber: nothing here signals
 * a threshold. */
const CATEGORY_TONES = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
] as const;

function isFreeSpace(name: string) {
  return /free\s+space/i.test(name);
}

/**
 * The context-composition popover's pure body: everything `useAgentContextReport` fetches,
 * rendered without touching a query client itself, so a test can render it directly with a plain
 * `data` fixture (same split as `RuntimeUsagePopoverContent`). Loading / stale / refreshing /
 * failed states mirror the runtime usage popover; every non-available scan result is shown
 * inline with its reason and what to do — never a toast.
 */
export function AgentContextPopoverContent({
  data,
  scanning,
  scanFailed = false,
  computerOnline,
  timeZone = null,
  onRefresh,
  refreshButtonWrapRef,
  /** The trigger badge's own tooltip line (`used / window tokens · time`); shown as the popover's
   * header line, exactly the runtime-usage twin's header pattern. */
  header = m.agent_context_title(),
}: {
  /** The trigger badge's own tooltip line; shown as the popover's header. */
  header?: string;
  data?: {
    state: "fresh" | "stale" | "missing";
    result?: {
      scanId: string;
      status: string;
      message?: string;
      report?: {
        provider: RuntimeProvider;
        model?: string;
        usedTokens: number;
        windowTokens: number;
        observedAt: string;
        categories: { name: string; tokens: number; approximate?: boolean }[];
        memoryFiles?: { kind: string; path: string; tokens: number; approximate?: boolean }[];
        skills?: { name: string; source: string; tokens: number; approximate?: boolean }[];
      };
      collectedAt: string;
    };
    pendingScanId?: string;
  };
  scanning: boolean;
  scanFailed?: boolean;
  computerOnline?: boolean;
  timeZone?: string | null;
  onRefresh: () => void;
  refreshButtonWrapRef?: RefObject<HTMLSpanElement | null>;
}) {
  const report = data?.result?.report;
  const reading = !data || (data.state === "missing" && (scanning || data.pendingScanId));
  const status = footerStatusText(data, scanning, computerOnline, scanFailed);

  return (
    <div>
      <div className="border-b border-secondary pb-3">
        <h2 className="min-w-0 font-medium text-primary">{header}</h2>
      </div>

      {reading ? (
        <p className="mt-3 text-tertiary">{m.agent_context_reading()}</p>
      ) : (
        <>
          {data?.state === "stale" && (
            <p className="mt-3 text-xs text-warning-primary">
              {scanning ? m.agent_context_stale_refreshing() : m.agent_context_stale()}
            </p>
          )}
          {report && <AgentContextReportBody report={report} />}
          {/* A failed status's reason is stated once, in the footer, like the runtime-usage twin. */}
        </>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-secondary pt-3">
        <div className="min-w-0 text-xs text-tertiary">
          {data?.result && (
            <p>
              {m.agent_context_updated()}{" "}
              <RelativeTime value={data.result.collectedAt} timeZone={timeZone} />
            </p>
          )}
          {status && <p className={data?.result ? "mt-1" : undefined}>{status}</p>}
        </div>
        <span ref={refreshButtonWrapRef} className="shrink-0">
          <Button
            type="button"
            color="secondary"
            size="sm"
            onPress={onRefresh}
            isDisabled={scanning || computerOnline === false}
            isLoading={scanning}
            iconLeading={RefreshCw}
          >
            {m.agent_context_refresh()}
          </Button>
        </span>
      </div>
    </div>
  );
}

type PopoverReport = NonNullable<NonNullable<AgentContextPopoverData["result"]>["report"]>;

function AgentContextReportBody({ report }: { report: PopoverReport; timeZone?: string | null }) {
  if (!report) return null;
  const locale = navigatorLocale();
  const numberFormat = new Intl.NumberFormat(locale);
  const percent = (tokens: number) =>
    report.windowTokens > 0
      ? Math.min(100, Math.max(0, Math.round((tokens / report.windowTokens) * 100)))
      : 0;
  return (
    <div className="mt-3">
      <p className="font-medium text-primary">
        {m.agent_context_tokens_of({
          tokens: numberFormat.format(report.usedTokens),
          window: numberFormat.format(report.windowTokens),
        })}
        {report.model ? ` · ${report.model}` : ""}
      </p>
      <StackedCategoryBar report={report} />
      <div className="mt-3">
        <p className={SECTION_LABEL_CLASS}>{m.agent_context_categories()}</p>
        <table className="mt-1.5 w-full text-sm">
          <tbody>
            {report.categories.map((category) => (
              <tr key={category.name} className="border-b border-secondary last:border-b-0">
                <td className="py-1.5 pr-2 align-middle">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        isFreeSpace(category.name)
                          ? "bg-secondary-solid"
                          : categoryTone(report.categories, category.name),
                      )}
                    />
                    <span className="truncate text-primary">{category.name}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-tertiary">
                  {numberFormat.format(category.tokens)}
                  {category.approximate ? "~" : ""}
                </td>
                <td className="py-1.5 text-right tabular-nums text-tertiary">
                  {percent(category.tokens)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.memoryFiles && report.memoryFiles.length > 0 && (
        <ItemList
          label={m.agent_context_memory_files()}
          items={report.memoryFiles.map((file) => ({
            key: `${file.kind}:${file.path}`,
            title: file.path,
            subtitle: file.kind,
            tokens: file.tokens,
            approximate: file.approximate === true,
          }))}
          numberFormat={numberFormat}
        />
      )}
      {report.skills && report.skills.length > 0 && (
        <ItemList
          label={m.agent_context_skills()}
          items={report.skills.map((skill) => ({
            key: `${skill.name}:${skill.source}`,
            title: skill.name,
            subtitle: skill.source,
            tokens: skill.tokens,
            approximate: skill.approximate === true,
          }))}
          numberFormat={numberFormat}
        />
      )}
    </div>
  );
}

const SECTION_LABEL_CLASS = "text-xs font-medium text-tertiary";

function StackedCategoryBar({ report }: { report: PopoverReport }) {
  const categories = report.categories;
  const total = categories.reduce((sum, category) => sum + category.tokens, 0) || 1;
  return (
    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-secondary">
      {categories.map((category) => (
        <div
          key={category.name}
          className={cn(
            "h-full",
            isFreeSpace(category.name)
              ? "bg-secondary-solid"
              : categoryTone(categories, category.name),
          )}
          style={{ width: `${(category.tokens / total) * 100}%` }}
          role="presentation"
        />
      ))}
    </div>
  );
}

function ItemList({
  label,
  items,
  numberFormat,
}: {
  label: string;
  items: { key: string; title: string; subtitle: string; tokens: number; approximate: boolean }[];
  numberFormat: Intl.NumberFormat;
}) {
  return (
    <div className="mt-3">
      <Disclosure className="rounded-lg border border-secondary">
        <Button
          slot="trigger"
          type="button"
          color="tertiary"
          size="sm"
          className="w-full justify-between"
          iconTrailing={ChevronDown}
        >
          {label} · {items.length}
        </Button>
        <DisclosurePanel className="border-t border-secondary p-2">
          <ul className="divide-y divide-secondary">
            {items.map((item) => (
              <li
                key={item.key}
                className="flex min-w-0 items-baseline justify-between gap-3 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs text-primary">
                    {item.title}
                  </span>
                  <span className="block truncate text-xs text-tertiary">{item.subtitle}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-tertiary">
                  {numberFormat.format(item.tokens)}
                  {item.approximate ? "~" : ""}
                </span>
              </li>
            ))}
          </ul>
        </DisclosurePanel>
      </Disclosure>
    </div>
  );
}

function categoryTone(categories: { name: string }[], name: string): string {
  const index = categories.findIndex((category) => category.name === name);
  return CATEGORY_TONE_AT(index);
}

/** Deterministic categorical tone for one category, Free space excluded by the caller. */
function CATEGORY_TONE_AT(index: number): string {
  return CATEGORY_TONES[index % CATEGORY_TONES.length]!;
}

function footerStatusText(
  data: Parameters<typeof AgentContextPopoverContent>[0]["data"],
  scanning: boolean,
  computerOnline: boolean | undefined,
  scanFailed: boolean,
): string | undefined {
  if (scanning) return m.agent_context_scanning();
  if (computerOnline === false) return m.agent_profile_computer_offline();
  if (scanFailed) return m.agent_context_no_response();
  return data?.result && !data.result.report
    ? contextFailureDescription(data.result.status)
    : undefined;
}

function contextFailureDescription(status: string): string {
  if (status === "unsupported") return m.agent_context_status_unsupported();
  if (status === "no_session") return m.agent_context_status_no_session();
  if (status === "unparsed") return m.agent_context_status_unparsed();
  if (status === "timeout") return m.agent_context_status_timeout();
  if (status === "error") return m.agent_context_status_error();
  return m.agent_context_status_error();
}

function navigatorLocale(): string {
  // Same viewer locale the profile tab's Context badge formats its tooltip through.
  return getLocale();
}
