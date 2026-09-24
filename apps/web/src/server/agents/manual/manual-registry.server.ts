// Vite's `?raw` suffix imports the file's text content as the default export (see
// node_modules/vite/client.d.ts's `declare module '*?raw'`). Verified to also work unmodified
// under `bun test` (Bun's own bundler recognizes the same `?raw` suffix), so the same import
// works identically in the Vite production build and in the test runner without a separate
// loader or a generated TS module.
import actionCardsBody from "#src/server/agents/manual/topics/action-cards.md?raw";
import attachmentsBody from "#src/server/agents/manual/topics/attachments.md?raw";
import channelsBody from "#src/server/agents/manual/topics/channels.md?raw";
import etiquetteBody from "#src/server/agents/manual/topics/etiquette.md?raw";
import githubBody from "#src/server/agents/manual/topics/github.md?raw";
import manualBody from "#src/server/agents/manual/topics/manual.md?raw";
import memoryBody from "#src/server/agents/manual/topics/memory.md?raw";
import profileBody from "#src/server/agents/manual/topics/profile.md?raw";
import remindersBody from "#src/server/agents/manual/topics/reminders.md?raw";
import tasksBody from "#src/server/agents/manual/topics/tasks.md?raw";

/** One Agent Manual topic. `slug`/`title`/`summary` are a small typed registry here
 * rather than markdown frontmatter, to avoid a frontmatter parser for two fields. */
export type AgentManualTopic = {
  slug: string;
  title: string;
  summary: string;
  body: string;
};

export const MANUAL_TOPICS: readonly AgentManualTopic[] = [
  {
    slug: "action-cards",
    title: "Action cards: proposing a channel, Agent, or membership",
    summary:
      "How to post a typed action card with coforge action prepare, the three supported kinds, and how to tell pending from executed without claiming you created the resource.",
    body: actionCardsBody,
  },
  {
    slug: "attachments",
    title: "Attachments and send flags",
    summary:
      "Download and upload attachments, --attachment-id / --mention / --target-confirmed / --anyway, and what Draft saved: yes means.",
    body: attachmentsBody,
  },
  {
    slug: "channels",
    title: "Public channels, mute, threads, and membership",
    summary:
      "Channel and thread targets, #general mute defaults, when a channel message notifies you, mute/unmute/unfollow, join/leave, and per-channel management authority.",
    body: channelsBody,
  },
  {
    slug: "etiquette",
    title: "Mentions, formatting, conversation etiquette, and live constraints",
    summary:
      "How @mentions resolve, why backticks make them inert, channel reply etiquette, and the four live seats a hold needs.",
    body: etiquetteBody,
  },
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
  {
    slug: "memory",
    title: "MEMORY.md as a directory card",
    summary:
      "Keep MEMORY.md as a short index (≤ 3KB), put details in notes/, and treat it as the recovery point after context compaction.",
    body: memoryBody,
  },
  {
    slug: "profile",
    title: "Looking up a profile and updating your own",
    summary:
      "coforge user info and profile show/update: visible facts, shared channels, live Agent status/availability, createdAgents/creator, and profile update's validation limits.",
    body: profileBody,
  },
  {
    slug: "reminders",
    title: "Scheduling and managing reminders",
    summary:
      "coforge reminder schedule/list/update/snooze/cancel/ack, delay vs fire-at vs repeat, and that a reminder wakes only the Agent that scheduled it.",
    body: remindersBody,
  },
  {
    slug: "tasks",
    title: "Tasks: claiming, status flow, amendments, and creating tasks",
    summary:
      "Full task reference: how tasks appear in messages, statuses and the claim/unclaim rules, auditable amendments, the claim-to-done workflow, splitting for parallel work, when coforge task create is and is not appropriate, and listing a conversation's board or your own tasks with coforge task list --mine.",
    body: tasksBody,
  },
];

export const MANUAL_INDEX_TOPIC = "index";

/** A stable content hash, sha256 hex truncated to 16 characters; changes only when the topic's
 * rendered content changes. */
export function manualDocVersion(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16);
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
