/** The two published bootstrap entry points, rooted at whichever deployment is being used.
 * Both consumers derive their text from here so neither can drift back to a fixed host. */
export function installCommands(origin: string): { posix: string; windows: string } {
  return {
    posix: `curl -fsSL ${origin}/computer/install.sh | sh`,
    windows: `irm ${origin}/computer/install.ps1 | iex`,
  };
}

/** The explicit second step of the two-command install flow: join the installed Computer to one
 * Workspace by slug. Kept beside installCommands so the full sequence has one source of truth,
 * even though this half doesn't depend on the deployment origin. */
export function setupCommand(workspaceSlug: string): string {
  return `coforge-computer setup --workspace ${workspaceSlug}`;
}
