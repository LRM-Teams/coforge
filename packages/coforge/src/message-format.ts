import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";

/** Any target containing `:` is a thread target (a channel/DM plus a rooting message id). */
function isThreadTarget(target: string): boolean {
  return target.includes(":");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Renders an ISO `createdAt` timestamp as UTC `YYYY-MM-DD HH:MM:SSZ`. */
export function formatUtcTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}Z`;
}

function attachmentSuffix(message: AgentMessageRecord): string {
  if (!message.attachment) return "";
  const { fileName, id } = message.attachment;
  return ` [attachment: ${fileName} (id:${id}) — download with coforge attachment view --id ${id} --output <path>]`;
}

function taskSuffix(message: AgentMessageRecord): string {
  if (!message.task) return "";
  const owner = message.task.owner ? ` owner=@${message.task.owner.handle}` : "";
  return ` [task #${message.task.number} status=${message.task.status}${owner}]`;
}

/** The message line shared by `message check`, `message resolve`, and held Task context. */
export function formatMessageLine(message: AgentMessageRecord): string {
  return `[target=${message.target} msg=${shortId(message.id)} time=${formatUtcTimestamp(message.createdAt)}] ${message.sender}: ${message.body}${attachmentSuffix(message)}${taskSuffix(message)}`;
}

type ReadWindowResponse = {
  messages?: AgentMessageRecord[];
  hasOlder?: boolean;
  hasNewer?: boolean;
};

export function formatReadWindow(
  target: string,
  response: ReadWindowResponse,
  options: { around?: string } = {},
): string {
  const messages = response.messages ?? [];
  if (messages.length === 0) return `No messages in ${target}.`;

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const older = response.hasOlder
    ? `Older exist: coforge message read --target "${target}" --before ${shortId(first.id)}.`
    : "No older.";
  const newer = response.hasNewer
    ? `Newer exist: coforge message read --target "${target}" --after ${shortId(last.id)}.`
    : "No newer.";

  const lines = [`Read window: ${messages.length} returned, oldest to newest. ${older} ${newer}`];
  if (options.around) lines.push(`Around: ${options.around}.`);
  lines.push("");

  const includeReplyTarget = !isThreadTarget(target);
  messages.forEach((message, index) => {
    const replyTarget = includeReplyTarget ? ` replyTarget=${target}:${shortId(message.id)}` : "";
    lines.push(
      `[${index + 1}/${messages.length} msg=${message.id} time=${formatUtcTimestamp(message.createdAt)}${replyTarget}] ${message.sender}: ${message.body}${attachmentSuffix(message)}${taskSuffix(message)}`,
    );
  });

  lines.push("");
  lines.push(`End of window: ${messages.length}/${messages.length} shown.`);
  return lines.join("\n");
}

const STRUCTURAL_TAG_PATTERN = /<\/?(?:result|preview|match)>|<omit \/>/g;
const REFERENCE_BOUNDARY = String.raw`[\s\[\]\(\)\{\}"'` + "`]";
const MENTION_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})@([A-Za-z0-9][\\w-]*)`, "g");
const CHANNEL_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})#([A-Za-z][\\w-]*)`, "g");
const TASK_REFERENCE_PATTERN = /\btask #(\d+)/gi;

/**
 * Rewrites reference-looking literals in free text so quoted content cannot pass as a real
 * reference, and escapes literal occurrences of the structural tags used to frame search
 * results/previews.
 */
export function neutralizeReferenceLiterals(text: string): string {
  let result = text.replace(STRUCTURAL_TAG_PATTERN, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
  result = result.replace(
    MENTION_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}user:${name}`,
  );
  result = result.replace(
    CHANNEL_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}channel:${name}`,
  );
  result = result.replace(TASK_REFERENCE_PATTERN, (_match, number: string) => `task:${number}`);
  return result;
}

function indexOfCaseInsensitive(haystack: string, needle: string): number {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/** The first whitespace-separated term of a search query; a quoted phrase counts as one term. */
function firstQueryTerm(query: string): string {
  const trimmed = query.trim();
  const match = /^"([^"]*)"|^(\S+)/.exec(trimmed);
  if (!match) return "";
  return (match[1] ?? match[2] ?? "").trim();
}

const PREVIEW_LEADING_CONTEXT = 80;
const PREVIEW_TRAILING_CONTEXT = 120;
const PREVIEW_NO_MATCH_LENGTH = 200;

/** Builds one search-result preview: a matched window of `body`, or the first 200 characters. */
export function renderSearchPreview(body: string, query: string): string {
  const trimmedQuery = query.trim();
  let matchStart = -1;
  let matchLength = 0;

  if (trimmedQuery) {
    const index = indexOfCaseInsensitive(body, trimmedQuery);
    if (index >= 0) {
      matchStart = index;
      matchLength = trimmedQuery.length;
    }
  }
  if (matchStart < 0) {
    const term = firstQueryTerm(query);
    if (term) {
      const index = indexOfCaseInsensitive(body, term);
      if (index >= 0) {
        matchStart = index;
        matchLength = term.length;
      }
    }
  }

  const hasMatch = matchStart >= 0;
  const matchEnd = matchStart + matchLength;
  const windowStart = hasMatch ? Math.max(0, matchStart - PREVIEW_LEADING_CONTEXT) : 0;
  const windowEnd = hasMatch
    ? Math.min(body.length, matchEnd + PREVIEW_TRAILING_CONTEXT)
    : Math.min(body.length, PREVIEW_NO_MATCH_LENGTH);
  const cutStart = hasMatch && windowStart > 0;
  const cutEnd = windowEnd < body.length;

  let pre = hasMatch ? body.slice(windowStart, matchStart) : "";
  const matched = hasMatch ? body.slice(matchStart, matchEnd) : "";
  let post = hasMatch ? body.slice(matchEnd, windowEnd) : body.slice(windowStart, windowEnd);

  if (cutStart) pre = pre.trimStart();
  if (cutEnd) post = post.trimEnd();

  const safePre = neutralizeReferenceLiterals(pre);
  const safeMatched = neutralizeReferenceLiterals(matched);
  const safePost = neutralizeReferenceLiterals(post);
  const core = hasMatch ? `${safePre}<match>${safeMatched}</match>${safePost}` : safePost;

  return `${cutStart ? "<omit />" : ""}${core}${cutEnd ? "<omit />" : ""}`;
}

type SearchResponse = {
  messages?: AgentMessageRecord[];
};

const SEARCH_CONTEXT_TIP =
  'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.';

export function formatSearchResults(query: string, response: SearchResponse): string {
  const messages = response.messages ?? [];
  if (messages.length === 0) return "No search results.";

  const count = messages.length;
  const noun = count === 1 ? "result" : "results";
  const header = query
    ? `Search results for: "${query}" (${count} ${noun})`
    : `Filtered message results (${count} ${noun})`;

  const blocks = messages.map((message) =>
    [
      `<result ref="msg:${message.id}">`,
      `Source: ${message.target}`,
      `Sender: ${neutralizeReferenceLiterals(message.sender)}`,
      `Time: ${formatUtcTimestamp(message.createdAt)}`,
      "",
      "<preview>",
      renderSearchPreview(message.body, query),
      "</preview>",
      "</result>",
    ].join("\n"),
  );

  return `${header}\n\n${blocks.join("\n\n")}\n\n${SEARCH_CONTEXT_TIP}`;
}

type SendResponse = {
  messageId?: string;
};

export function formatSendSuccess(target: string, response: SendResponse): string {
  if (!response.messageId) return `Message sent to ${target}.`;
  const hint = isThreadTarget(target)
    ? ""
    : ` (to reply in this message's thread, use target "${target}:${shortId(response.messageId)}")`;
  return `Message sent to ${target}. Message ID: ${response.messageId}${hint}`;
}

type AttachmentUploadResponse = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

/** Matches Raft 1.0.32's `formatAttachmentUploaded` shape exactly, `raft` swapped for `coforge`. */
export function formatAttachmentUploadSuccess(response: AttachmentUploadResponse): string {
  const sizeKB = (response.sizeBytes / 1024).toFixed(1);
  return (
    `File uploaded: ${response.fileName} (${sizeKB}KB)\n` +
    `Attachment ID: ${response.id}\n\n` +
    `Use this ID with coforge message send --attachment-id ${response.id} to include it in a message.`
  );
}

type HeldSendResponse = {
  attentionCount?: number;
  anywayAllowed?: boolean;
  messages?: AgentMessageRecord[];
};

function formatUtcHourMinute(createdAt: string): string {
  return formatUtcTimestamp(createdAt).slice(11, 16);
}

function formatHeldPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 160) return collapsed;
  const remaining = collapsed.length - 160;
  return `${collapsed.slice(0, 160)}…⟨${remaining} more chars⟩`;
}

export function formatHeldSend(target: string, response: HeldSendResponse): string {
  const messages = response.messages ?? [];
  const count = response.attentionCount ?? messages.length;
  const lines = [
    `Freshness hold: ${count} newer ${count === 1 ? "message" : "messages"} arrived on ${target} before your reply was sent.`,
    ...messages.map(
      (message) =>
        `  │ ${message.sender} ${formatUtcHourMinute(message.createdAt)}  ${formatHeldPreview(message.body)}`,
    ),
    "Your message has been saved as a draft.",
    "To update the draft, send revised content normally:",
    `  coforge message send --target "${target}" <<'COFORGE_MESSAGE'`,
    "  revised message",
    "  COFORGE_MESSAGE",
    "To send the current draft unchanged:",
    `  coforge message send --target "${target}" --send-draft`,
  ];
  if (response.anywayAllowed) {
    lines.push("If repeated updates keep holding the same still-correct reply:");
    lines.push(`  coforge message send --target "${target}" --send-draft --anyway`);
  }
  return lines.join("\n");
}
