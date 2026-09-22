import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Plus, XClose as X } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { m } from "@/paraglide/messages";
import { LeaderFormatSectionsEditor } from "./leader-format-sections-editor";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import type { ReportContent } from "./records-content";
import { cn } from "@/lib/utils";
import type { UploadResult } from "./report-editor/types";
import { RecordsReadingColumn } from "./records-reading-column";

export function ReportTabsEditor({
  content,
  editable = true,
  editableTabs = false,
  placeholder,
  contentRevision = 0,
  trailingTabs,
  renderTrailingTab,
  onChange,
  onBlur,
  onUploadFile,
}: {
  content: ReportContent;
  editable?: boolean;
  editableTabs?: boolean;
  placeholder: string;
  /** Bump to remount the active section editor (e.g. assistant insert). */
  contentRevision?: number;
  /** Special tabs appended after content.tabs (e.g. Leader 要点提炼). */
  trailingTabs?: readonly { id: string; label: string }[];
  renderTrailingTab?: (id: string) => ReactNode;
  onChange: (content: ReportContent) => void;
  onBlur?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
}) {
  const pages = content.tabs ?? { Summary: { markdown: content.markdown ?? "" } };
  const tabNames = Object.keys(pages);
  const trailing = trailingTabs ?? [];
  const allTabIds = [...tabNames, ...trailing.map((tab) => tab.id)];
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? trailing[0]?.id ?? "");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const activeTab = allTabIds.includes(selectedTab)
    ? selectedTab
    : (tabNames[0] ?? trailing[0]?.id ?? "");
  const trailingActive = trailing.some((tab) => tab.id === activeTab);

  useEffect(() => {
    if (!allTabIds.includes(selectedTab)) setSelectedTab(tabNames[0] ?? trailing[0]?.id ?? "");
  }, [selectedTab, allTabIds.join("\u0000")]);

  function updateTabOverflow() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setTabOverflow({
      left: scroller.scrollLeft > 4,
      right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4,
    });
  }

  useLayoutEffect(() => {
    updateTabOverflow();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => updateTabOverflow());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabNames.join("\u0000")]);

  function scrollTabs(direction: -1 | 1) {
    scrollerRef.current?.scrollBy({ left: direction * 160, behavior: "smooth" });
  }

  function defaultTabName() {
    const base = m.records_template_heading_level_one();
    if (!pages[base]) return base;
    let index = 2;
    while (pages[`${base} ${index}`]) index += 1;
    return `${base} ${index}`;
  }

  function addTab() {
    const name = defaultTabName();
    onChange({
      tabs: {
        ...pages,
        [name]: { markdown: "" },
      },
    });
    setSelectedTab(name);
    setEditingTab(name);
    setEditingName("");
  }

  function startEditingTab(name: string) {
    if (!editableTabs) return;
    setEditingTab(name);
    setEditingName(name);
  }

  function commitEditingTab() {
    if (!editingTab) return;
    const name = editingName.trim();
    const original = editingTab;
    setEditingTab(null);
    if (!name || name === original || pages[name]) return;
    const renamed = Object.fromEntries(
      Object.entries(pages).map(([tabName, tab]) => [tabName === original ? name : tabName, tab]),
    );
    onChange({ tabs: renamed });
    if (activeTab === original) setSelectedTab(name);
  }

  function handleEditChange(event: ChangeEvent<HTMLInputElement>) {
    setEditingName(event.target.value);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditingTab();
    }
    if (event.key === "Escape") setEditingTab(null);
  }

  function moveTab(source: string, target: string) {
    if (source === target) return;
    const entries = Object.entries(pages);
    const sourceEntry = entries.find(([name]) => name === source);
    if (!sourceEntry) return;
    const remaining = entries.filter(([name]) => name !== source);
    const targetIndex = remaining.findIndex(([name]) => name === target);
    remaining.splice(targetIndex, 0, sourceEntry);
    onChange({ tabs: Object.fromEntries(remaining) });
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, name: string) {
    setDraggedTab(name);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", name);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, target: string) {
    event.preventDefault();
    const source = draggedTab ?? event.dataTransfer.getData("text/plain");
    if (source) moveTab(source, target);
    setDraggedTab(null);
  }

  function removeTab(name: string) {
    if (tabNames.length <= 1) return;
    const nextTabs = Object.fromEntries(
      Object.entries(pages).filter(([tabName]) => tabName !== name),
    );
    onChange({ tabs: nextTabs });
    if (activeTab === name) {
      const nextName = Object.keys(nextTabs)[0] ?? "";
      setSelectedTab(nextName);
    }
  }

  function updateMarkdown(markdown: string) {
    if (!editable) return;
    const tab = pages[activeTab];
    if (!tab) return;
    onChange({
      tabs: {
        ...pages,
        [activeTab]: { ...tab, markdown },
      },
    });
  }

  const activeContent = pages[activeTab]?.markdown ?? "";
  const readingTabs = !editableTabs;

  const tabButtonClass = (active: boolean) =>
    editableTabs
      ? cn(
          "mb-2 rounded-md px-2.5 py-1.5",
          active
            ? "bg-primary text-primary shadow-xs ring-1 ring-secondary"
            : "bg-secondary_alt text-tertiary hover:bg-primary_hover hover:text-primary",
        )
      : cn(
          "rounded-none px-1 pb-2.5 pt-1 text-sm",
          active
            ? "border-b-2 border-brand-solid font-semibold text-primary"
            : "border-b-2 border-transparent text-tertiary hover:text-secondary",
        );

  const tabBar = (
    <>
      {tabOverflow.left ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={ChevronLeft}
          aria-label={m.records_format_tab_scroll_prev()}
          onClick={() => scrollTabs(-1)}
          className="mb-2 size-6 shrink-0 p-1"
        />
      ) : null}
      <nav
        ref={scrollerRef}
        aria-label={m.records_template_dimension()}
        onScroll={updateTabOverflow}
        className={cn(
          "flex min-w-0 flex-1 items-center overflow-x-auto pt-0",
          readingTabs ? "gap-8 sm:gap-10" : "gap-2 sm:gap-2",
        )}
      >
        {tabNames.map((name) => (
          <div
            key={name}
            draggable={editableTabs}
            onDragStart={(event) => handleDragStart(event, name)}
            onDragOver={(event) => {
              if (editableTabs) event.preventDefault();
            }}
            onDrop={(event) => handleDrop(event, name)}
            onDragEnd={() => setDraggedTab(null)}
            className={cn(
              "group flex shrink-0 items-center gap-0.5",
              draggedTab === name && "opacity-50",
            )}
          >
            {editingTab === name ? (
              <input
                autoFocus
                value={editingName}
                aria-label={`${m.records_template_dimension()}: ${name}`}
                onChange={handleEditChange}
                onBlur={commitEditingTab}
                onKeyDown={handleEditKeyDown}
                className="mb-2 h-8 w-28 min-w-0 border-b-2 border-brand bg-transparent px-0.5 text-sm font-semibold text-primary outline-none"
              />
            ) : (
              <Button
                type="button"
                size="sm"
                color="link-gray"
                aria-selected={name === activeTab}
                onPress={() => setSelectedTab(name)}
                onDoubleClick={() => startEditingTab(name)}
                className={tabButtonClass(name === activeTab)}
              >
                {name}
              </Button>
            )}
            {editableTabs ? (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={X}
                aria-label={`${m.records_template_delete()}: ${name}`}
                isDisabled={tabNames.length <= 1}
                onClick={() => removeTab(name)}
                className="mb-2 size-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              />
            ) : null}
          </div>
        ))}
        {trailing.map((tab) => (
          <div key={tab.id} className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="sm"
              color="link-gray"
              aria-selected={tab.id === activeTab}
              onPress={() => setSelectedTab(tab.id)}
              className={tabButtonClass(tab.id === activeTab)}
            >
              {tab.label}
            </Button>
          </div>
        ))}
      </nav>
      {tabOverflow.right ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={ChevronRight}
          aria-label={m.records_format_tab_scroll_next()}
          onClick={() => scrollTabs(1)}
          className="mb-2 size-6 shrink-0 p-1"
        />
      ) : null}
      {editableTabs ? (
        <Button
          type="button"
          size="sm"
          color="link-gray"
          iconLeading={Plus}
          onPress={addTab}
          className="mb-2 shrink-0 px-1"
        >
          {m.records_template_add_heading_level_one()}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {readingTabs ? (
        <div className="relative shrink-0">
          <RecordsReadingColumn className="pb-0 pt-2">
            <div className="flex items-end gap-1 border-b border-secondary/40">{tabBar}</div>
          </RecordsReadingColumn>
        </div>
      ) : (
        <div className="flex shrink-0 items-end gap-1 border-b border-secondary px-2 pt-3 sm:px-6">
          {tabBar}
        </div>
      )}

      {trailingActive ? (
        (renderTrailingTab?.(activeTab) ?? null)
      ) : editableTabs ? (
        <LeaderFormatSectionsEditor
          key={`${activeTab}:${contentRevision}`}
          defaultValue={activeContent}
          onUpdate={updateMarkdown}
          onBlur={onBlur}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsReadingColumn className="pt-5">
            <ReportSectionEditor
              key={`${activeTab}:${contentRevision}`}
              defaultValue={activeContent}
              placeholder={placeholder}
              className="min-h-[55vh] pb-[45vh]"
              editable={editable}
              onUploadFile={onUploadFile}
              onUpdate={updateMarkdown}
              onBlur={onBlur}
            />
          </RecordsReadingColumn>
        </div>
      )}
    </div>
  );
}
