import { useEffect, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { Plus, XClose as X } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { m } from "@/paraglide/messages";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import type { ReportContent } from "./records-content";
import { cn } from "@/lib/utils";
import type { UploadResult } from "./report-editor/types";

export function ReportTabsEditor({
  content,
  editableTabs = false,
  placeholder,
  onChange,
  onBlur,
  onUploadFile,
}: {
  content: ReportContent;
  editableTabs?: boolean;
  placeholder: string;
  onChange: (content: ReportContent) => void;
  onBlur: () => void;
  onUploadFile: (file: File) => Promise<UploadResult | null>;
}) {
  const pages = content.tabs ?? { Summary: { markdown: content.markdown ?? "" } };
  const tabNames = Object.keys(pages);
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? "");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const activeTab = tabNames.includes(selectedTab) ? selectedTab : (tabNames[0] ?? "");

  useEffect(() => {
    if (!tabNames.includes(selectedTab)) setSelectedTab(tabNames[0] ?? "");
  }, [selectedTab, tabNames.join("\u0000")]);

  function defaultTabName() {
    const base = m.records_template_default_dimension();
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
    commitEditingTab();
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label={m.records_template_dimension()}
        className="flex shrink-0 items-end gap-4 overflow-x-auto border-b border-secondary px-4 pt-3 sm:gap-6 sm:px-8"
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
              "flex shrink-0 items-center gap-0.5",
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
                className={cn(
                  "rounded-none border-b-2 px-0.5 pt-1 pb-3.5",
                  name === activeTab
                    ? "border-brand text-brand-secondary hover:text-brand-secondary"
                    : "border-transparent text-tertiary hover:border-brand hover:text-brand-secondary",
                )}
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
                className="mb-2 size-5"
              />
            ) : null}
          </div>
        ))}
        {editableTabs ? (
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={Plus}
            aria-label={m.records_template_add_dimension()}
            onClick={addTab}
            className="mb-2 size-6 p-1"
          />
        ) : null}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
        <ReportSectionEditor
          key={activeTab}
          defaultValue={activeContent}
          placeholder={placeholder}
          className="min-h-[55vh] pb-[30vh]"
          onUploadFile={onUploadFile}
          onUpdate={updateMarkdown}
          onBlur={onBlur}
        />
      </div>
    </div>
  );
}
