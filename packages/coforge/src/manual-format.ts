/** Text renderers for `coforge manual get|search`, matching Raft 1.0.32's `raft
 * manual` stdout formats verbatim. */

import type { AgentManualSearchResult } from "@lrm/coforge-sdk/agent";

/** `manual get`'s stdout is the doc content verbatim, ending in exactly one newline. The CLI
 * entry point prints a string result with `console.log`, which supplies that newline. */
export function formatManualGet(content: string): string {
  return content.replace(/\n+$/, "");
}

/** `manual search`'s stdout: `1. <slug> — <title>` per result, each non-empty `firstScreen` line
 * indented three spaces underneath, results separated by a blank line. The trailing newline
 * comes from the CLI entry point's `console.log`. */
export function formatManualSearchResults(results: readonly AgentManualSearchResult[]): string {
  const blocks = results.map((result, index) => {
    const lines = [`${index + 1}. ${result.slug} — ${result.title}`];
    for (const line of result.firstScreen.split("\n"))
      if (line.length > 0) lines.push(`   ${line}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
