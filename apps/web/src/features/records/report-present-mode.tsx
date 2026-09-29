import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import { isReportImageZoomOpen } from "./report-image-zoom";
import { stepReportPage } from "./report-present";
import { RecordsReadingColumn } from "./records-reading-column";

export function ReportPresentMode({
  pages,
  startIndex,
  placeholder,
  onClose,
}: {
  pages: ReadonlyArray<{ name: string; markdown: string }>;
  startIndex: number;
  placeholder: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(pages.length - 1, 0)),
  );
  const page = pages[index];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (isReportImageZoomOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((current) => stepReportPage(current, pages.length, -1));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((current) => stepReportPage(current, pages.length, 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, pages.length]);

  if (!page) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-primary"
      role="dialog"
      aria-modal="true"
      aria-label={page.name}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-secondary px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-primary">
          {page.name}
        </h2>
        <span className="text-sm text-tertiary">
          {index + 1} / {pages.length}
        </span>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={X}
          aria-label={m.records_report_present_close()}
          onClick={onClose}
        />
      </header>
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          <RecordsReadingColumn className="py-8">
            <ReportSectionEditor
              key={page.name}
              defaultValue={page.markdown}
              placeholder={placeholder}
              editable={false}
              onUpdate={() => {}}
            />
          </RecordsReadingColumn>
        </div>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={ChevronLeft}
          aria-label={m.records_report_present_prev()}
          isDisabled={index === 0}
          onClick={() => setIndex((current) => stepReportPage(current, pages.length, -1))}
          className="absolute top-1/2 left-3 -translate-y-1/2"
        />
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={ChevronRight}
          aria-label={m.records_report_present_next()}
          isDisabled={index === pages.length - 1}
          onClick={() => setIndex((current) => stepReportPage(current, pages.length, 1))}
          className="absolute top-1/2 right-3 -translate-y-1/2"
        />
      </div>
    </div>,
    document.body,
  );
}
