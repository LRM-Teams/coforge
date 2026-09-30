import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

/**
 * The reasoning levels a Pi model offers, as the SDK decides them (`getSupportedThinkingLevels`):
 * a `thinkingLevelMap` entry of `null` removes a level, a missing entry keeps it, and `xhigh` and
 * `max` exist only when mapped. A model without reasoning offers none, so no picker is shown.
 */
export function supportedReasoningEfforts(model: unknown): string[] {
  if (typeof model !== "object" || model === null || Reflect.get(model, "reasoning") !== true)
    return [];
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]);
}
