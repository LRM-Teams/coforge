/** The two published bootstrap entry points, rooted at whichever deployment is being used.
 * Both consumers derive their text from here so neither can drift back to a fixed host. */
export function installCommands(origin: string): {
  posix: string;
  windows: string;
} {
  return {
    posix: `curl -fsSL ${origin}/computer/install.sh | sh`,
    windows: `irm ${origin}/computer/install.ps1 | iex`,
  };
}

/** The second step: sign the installed Computer in to this deployment. `setup` cannot run before
 * it, because registering a Computer needs a credential to register as - so the sequence is
 * stated here rather than left for the user to discover from a failure. */
export function loginCommand(): string {
  return `coforge-computer login`;
}

/** The explicit third step of the install flow: join the signed-in Computer to one Workspace by
 * slug. Kept beside installCommands so the full sequence has one source of truth, even though
 * this half doesn't depend on the deployment origin. */
export function setupCommand(workspaceSlug: string): string {
  return `coforge-computer setup --workspace ${workspaceSlug}`;
}
