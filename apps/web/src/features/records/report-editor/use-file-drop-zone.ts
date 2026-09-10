import { useState, useEffect, useCallback, useRef } from "react";

interface UseFileDropZoneOptions {
  onDrop: (files: File[]) => void;
  enabled?: boolean;
}

function dragHasFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

/**
 * Window-level file drag/drop for the report editor.
 * Tracks drag depth so nested targets do not flicker the overlay.
 */
export function useFileDropZone({ onDrop, enabled = true }: UseFileDropZoneOptions) {
  const [isDragging, setIsDragging] = useState(false);
  const depthRef = useRef(0);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    depthRef.current = 0;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      reset();
      return;
    }

    const onDragEnter = (event: DragEvent) => {
      if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
      event.preventDefault();
      depthRef.current += 1;
      setIsDragging(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: DragEvent) => {
      if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
      event.preventDefault();
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setIsDragging(false);
    };

    const onDropEvent = (event: DragEvent) => {
      if (!dragHasFiles(Array.from(event.dataTransfer?.types ?? []))) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      reset();
      if (files.length > 0) onDropRef.current(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDropEvent);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDropEvent);
    };
  }, [enabled, reset]);

  return { isDragging };
}
