/** Start preparing a handoff before the provider reaches its hard context limit. */
export const CONTEXT_HANDOFF_THRESHOLD = 0.8;

export function contextHandoffPrompt(percent: number): string {
  return [
    `Context usage reached ${percent}% of the provider window. Prepare an Agent handoff now.`,
    "Write or update `.coforge-handoff.md` in the Agent workspace with:",
    "- the current goal and acceptance criteria",
    "- completed work and files changed",
    "- decisions, constraints, failed approaches, and important errors",
    "- the exact next steps for a fresh session",
    "Keep the note factual and concise, do not include secrets, and then continue the current turn.",
  ].join("\n");
}

/** The activity line for a handoff that is starting. It takes the percent the prompt states, because
 * the activity and the prompt describe one event: "reached 80%" next to "reached 83% of the provider
 * window" is two answers to the same question, and the threshold above must not be spelled twice. */
export function contextHandoffActivity(percent: number): string {
  return `Context usage reached ${percent}%; preparing handoff.`;
}

export class ContextHandoffCoordinator {
  #requested = false;

  constructor(private readonly request: (handoff: { prompt: string; percent: number }) => void) {}

  observe(usedTokens: number, windowTokens: number): boolean {
    if (
      this.#requested ||
      !Number.isFinite(usedTokens) ||
      !Number.isFinite(windowTokens) ||
      usedTokens < 0 ||
      windowTokens <= 0
    )
      return false;
    const ratio = usedTokens / windowTokens;
    if (ratio < CONTEXT_HANDOFF_THRESHOLD) return false;
    const percent = Math.floor(ratio * 100);
    this.#requested = true;
    this.request({ prompt: contextHandoffPrompt(percent), percent });
    return true;
  }

  reset(): void {
    this.#requested = false;
  }
}
