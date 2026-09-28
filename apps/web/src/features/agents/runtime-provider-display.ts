import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex-color.svg";
import cursorMark from "@lobehub/icons-static-svg/icons/cursor.svg";
import kiroMark from "@lobehub/icons-static-svg/icons/kiro-color.svg";
import grokMark from "@lobehub/icons-static-svg/icons/grok.svg";
import opencodeMark from "@lobehub/icons-static-svg/icons/opencode.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { m } from "#src/paraglide/messages";

/**
 * The one display table for a RuntimeProvider: shared by the Agent runtime picker, the Agent
 * detail page, and the Computer runtime usage panel. Adding a RuntimeProvider value without
 * adding an entry here fails to compile.
 */

/** The order the runtime picker has always listed providers in; CoForge is offered separately
 * since it is always shown regardless of the Computer's reported provider set. */
export const RUNTIME_PROVIDER_DISPLAY_ORDER: readonly RuntimeProvider[] = [
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.GROK,
];

/** The label shown in the runtime picker and the Agent detail page. CoForge's own built-in
 * runtime is localized; the others show the provider's own name verbatim. */
export function runtimeProviderLabel(provider: RuntimeProvider): string {
  const labels: Record<RuntimeProvider, string> = {
    [RUNTIME_PROVIDER.COFORGE]: m.agent_provider_pi_builtin(),
    [RUNTIME_PROVIDER.PI]: "Pi",
    [RUNTIME_PROVIDER.CODEX]: "Codex",
    [RUNTIME_PROVIDER.CLAUDE_CODE]: "Claude Code",
    [RUNTIME_PROVIDER.KIRO]: "Kiro",
    [RUNTIME_PROVIDER.CURSOR]: "Cursor CLI",
    [RUNTIME_PROVIDER.OPENCODE]: "OpenCode",
    [RUNTIME_PROVIDER.GROK]: "Grok Build",
  };
  return labels[provider];
}

/** Every provider's mark (icon). */
export const RUNTIME_PROVIDER_MARK: Record<RuntimeProvider, string> = {
  [RUNTIME_PROVIDER.COFORGE]: "/logo.svg",
  [RUNTIME_PROVIDER.PI]: piMark,
  [RUNTIME_PROVIDER.CODEX]: codexMark,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: claudeCodeMark,
  [RUNTIME_PROVIDER.KIRO]: kiroMark,
  [RUNTIME_PROVIDER.CURSOR]: cursorMark,
  [RUNTIME_PROVIDER.OPENCODE]: opencodeMark,
  [RUNTIME_PROVIDER.GROK]: grokMark,
};

/** Whether that mark is a full-color icon rendered as an `<img>`, as opposed to a monochrome
 * glyph that must be recolored with a CSS mask to match the current theme. */
export const RUNTIME_PROVIDER_MARK_IS_COLOR_ICON: Record<RuntimeProvider, boolean> = {
  [RUNTIME_PROVIDER.COFORGE]: true,
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.KIRO]: true,
  [RUNTIME_PROVIDER.CURSOR]: false,
  [RUNTIME_PROVIDER.OPENCODE]: false,
  [RUNTIME_PROVIDER.GROK]: false,
};
