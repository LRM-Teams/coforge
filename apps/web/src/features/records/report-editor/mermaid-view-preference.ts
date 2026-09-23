/**
 * Client preference for Mermaid diagram / source / split display.
 *
 * Fence attrs (`mermaid view=…`) persist for editable bodies. Read-only
 * surfaces still let the user flip the toolbar, so we keep a chart-keyed
 * preference across refresh without rewriting someone else's markdown.
 */

import type { MermaidViewMode } from "#src/features/records/report-editor/extensions/code-block-fence";
import { normalizeMermaidView } from "#src/features/records/report-editor/extensions/code-block-fence";

const STORAGE_PREFIX = "coforge:mermaid-view:v1:";

type PreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function defaultStorage(): PreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function chartKey(chart: string): string | null {
  const normalized = chart.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;
  // FNV-1a 32-bit — short, stable, good enough for preference keys.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${STORAGE_PREFIX}${(hash >>> 0).toString(16)}`;
}

export function readMermaidViewPreference(
  chart: string,
  storage: PreferenceStorage | null = defaultStorage(),
): MermaidViewMode | null {
  if (!storage) return null;
  const key = chartKey(chart);
  if (!key) return null;
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    return normalizeMermaidView(raw);
  } catch {
    return null;
  }
}

export function writeMermaidViewPreference(
  chart: string,
  mode: MermaidViewMode,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  const key = chartKey(chart);
  if (!key) return;
  try {
    storage.setItem(key, normalizeMermaidView(mode));
  } catch {
    // Quota / private mode — preference is best-effort.
  }
}

/**
 * Prefer an explicit document fence/attr over a client preference, then the
 * preference, then split (`both`).
 */
export function resolveMermaidViewMode(
  input: {
    attrView: unknown;
    fenceView: MermaidViewMode;
    chart: string;
  },
  storage: PreferenceStorage | null = defaultStorage(),
): MermaidViewMode {
  const attr = normalizeMermaidView(input.attrView);
  if (input.attrView != null && attr !== "both") return attr;
  if (input.fenceView !== "both") return input.fenceView;
  return readMermaidViewPreference(input.chart, storage) ?? "both";
}
