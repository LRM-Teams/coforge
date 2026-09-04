/** The two published bootstrap entry points, rooted at whichever deployment is being used.
 * Both consumers derive their text from here so neither can drift back to a fixed host. */
export function installCommands(origin: string): { posix: string; windows: string } {
  return {
    posix: `curl -fsSL ${origin}/computer/install.sh | sh`,
    windows: `irm ${origin}/computer/install.ps1 | iex`,
  };
}
