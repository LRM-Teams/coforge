import { createHash } from "node:crypto";
// Vite's `?raw` suffix imports the file's text content as the default export (see
// node_modules/vite/client.d.ts's `declare module '*?raw'`). Verified to also work unmodified
// under `bun test` (Bun's own bundler recognizes the same `?raw` suffix), so the same import
// works identically in the Vite production build and in the test runner without a separate
// loader or a generated TS module.
import githubBody from "./topics/github.md?raw";
import manualBody from "./topics/manual.md?raw";

/** One Agent Manual topic (ADR 0036). `slug`/`title`/`summary` are a small typed registry here
 * rather than markdown frontmatter, to avoid a frontmatter parser for two fields. */
export type AgentManualTopic = {
  slug: string;
  title: string;
  summary: string;
  body: string;
};

export const MANUAL_TOPICS: readonly AgentManualTopic[] = [
  {
    slug: "github",
    title: "Working with a Project's GitHub repository",
    summary:
      "Clone a Project's bound GitHub repository, use pre-authenticated git/gh, and push a branch and open a pull request instead of pushing to the default branch.",
    body: githubBody,
  },
  {
    slug: "manual",
    title: "Using the Agent Manual",
    summary:
      "How to read a Manual topic or the topic index, search by keyword, and what --intent/--reason mean and must never contain.",
    body: manualBody,
  },
];

export const MANUAL_INDEX_TOPIC = "index";

/** A stable content hash, sha256 hex truncated to 16 characters; changes only when the topic's
 * rendered content changes. */
export function manualDocVersion(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** The `index` topic: a generated markdown catalog, never hand-maintained separately from
 * `MANUAL_TOPICS`. */
export function buildManualIndexContent(): string {
  const lines = [
    "# CoForge Agent Manual",
    "",
    "Available topics:",
    "",
    ...MANUAL_TOPICS.map((topic) => `- ${topic.slug} — ${topic.title}: ${topic.summary}`),
    "",
    "Run `coforge manual get <slug> --intent <text> --reason <text>` to read a topic, or " +
      '`coforge manual search "<keywords>" --intent <text> --reason <text>` to search by keyword.',
  ];
  return lines.join("\n");
}

export function findManualTopic(slug: string): AgentManualTopic | undefined {
  return MANUAL_TOPICS.find((topic) => topic.slug === slug);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** Raft-aligned: `manual get` stdout is the doc content verbatim, always ending in a newline. */
export { ensureTrailingNewline };
