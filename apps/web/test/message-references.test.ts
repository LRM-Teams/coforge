import { expect, test } from "bun:test";
import {
  channelReferenceToken,
  replaceMentionTokens,
  replaceTaskReferenceTokens,
  resolveMentionTargets,
  taskReferenceToken,
  threadReferenceToken,
  type MentionTarget,
} from "@lrm/coforge-sdk/internal";
import { formatSelectionQuote } from "#src/features/conversations/message-quote";
import { readMessageReferences, type MessageReferenceLookup } from "#src/lib/message-references";

/** What a body could mean, read the way a send reads it. */
const messageReferenceCandidates = (body: string) => readMessageReferences(body).candidates;
/** The stored body once `lookup` answers the candidates. */
const resolveMessageReferences = (body: string, lookup: MessageReferenceLookup) =>
  readMessageReferences(body).resolve(lookup);

const ADA = {
  key: "member-ada",
  type: "user" as const,
  id: "11111111-1111-4111-8111-111111111111",
  handle: "ada",
};
const HELPER = {
  key: "member-helper",
  type: "agent" as const,
  id: "22222222-2222-4222-8222-222222222222",
  handle: "helper",
};
const PRODUCT = { id: "33333333-3333-4333-8333-333333333333", name: "product" };
const RANDOM = { id: "44444444-4444-4444-8444-444444444444", name: "random" };
const DIGITS = { id: "55555555-5555-4555-8555-555555555555", name: "132" };
const CHANNELS = new Map([PRODUCT, RANDOM, DIGITS].map((channel) => [channel.name, channel]));
const channel = (name: string) => CHANNELS.get(name);

/** The send path's shape: resolve the mention targets from the candidates, then tokenize once. */
function storedBody(
  body: string,
  targets: readonly MentionTarget[],
  bindings: Parameters<typeof resolveMentionTargets>[2] = [],
) {
  const { handles } = messageReferenceCandidates(body);
  const resolution = resolveMentionTargets(handles, targets, bindings);
  return {
    body: resolveMessageReferences(body, { mention: resolution.target }),
    mentions: resolution.mentions,
  };
}

// Channels.

test("a #name that names a channel becomes a token; any other #name stays byte-for-byte", () => {
  expect(resolveMessageReferences("see #product, not #nope.", { channel })).toBe(
    `see ${channelReferenceToken(PRODUCT.id, "product")}, not #nope.`,
  );
});

test("a channel name matches case-insensitively and stores the channel's own name", () => {
  expect(resolveMessageReferences("try #Product", { channel })).toBe(
    `try ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("the whole #name run is one name, in any script", () => {
  // `#product-launch` names `product-launch`, never `product` followed by `-launch`.
  expect(resolveMessageReferences("#product-launch", { channel })).toBe("#product-launch");
  // Letters in any script continue the name, so CJK written straight after it is part of it.
  expect(resolveMessageReferences("去#random频道", { channel })).toBe("去#random频道");
  // There is no left boundary: CJK before the `#` does not stop the reference.
  expect(resolveMessageReferences("去#random 频道", { channel })).toBe(
    `去${channelReferenceToken(RANDOM.id, "random")} 频道`,
  );
});

test("a #name inside inline code or a fenced block is never a reference", () => {
  const body = "`#product` and\n```\n#product\n```\nand #product";
  expect(resolveMessageReferences(body, { channel })).toBe(
    `\`#product\` and\n\`\`\`\n#product\n\`\`\`\nand ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("code is whatever the Markdown renderer shows as code: a mid-line ``` opens no fence", () => {
  // A fence only opens at the start of a line; the renderer shows this `#product` as prose, so it
  // is a reference like any other prose.
  expect(resolveMessageReferences("run ``` then #product", { channel })).toBe(
    `run \`\`\` then ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("a #name inside a URL stays part of the URL", () => {
  for (const body of [
    "https://example.com/docs#product",
    "<https://example.com/#product>",
    "www.example.com/page#product",
    "[docs](https://example.com/docs#product)",
  ])
    expect(resolveMessageReferences(body, { channel })).toBe(body);
});

test("a #name in a link's label is part of the link, not a reference", () => {
  expect(
    resolveMessageReferences("[see #product](https://example.com) or #product", { channel }),
  ).toBe(`[see #product](https://example.com) or ${channelReferenceToken(PRODUCT.id, "product")}`);
});

test("an escaped \\#name is literal text, not a reference", () => {
  expect(resolveMessageReferences("\\#product and #product", { channel })).toBe(
    `\\#product and ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("a #name in a GFM table cell is a reference, and the table keeps every other byte", () => {
  const body = "| where | why |\n|---|---|\n| #product | launch |";
  expect(resolveMessageReferences(body, { channel })).toBe(
    `| where | why |\n|---|---|\n| ${channelReferenceToken(PRODUCT.id, "product")} | launch |`,
  );
});

test("text before a reference in any script, emoji included, keeps its bytes", () => {
  expect(resolveMessageReferences("😀🚀 去 #random, 👍", { channel })).toBe(
    `😀🚀 去 ${channelReferenceToken(RANDOM.id, "random")}, 👍`,
  );
});

test("inline markup around a reference keeps every byte outside it", () => {
  expect(resolveMessageReferences("**see #product**\n\n> and #random", { channel })).toBe(
    `**see ${channelReferenceToken(PRODUCT.id, "product")}**\n\n> and ${channelReferenceToken(RANDOM.id, "random")}`,
  );
});

test("a reference on an indented continuation line still resolves in place", () => {
  expect(resolveMessageReferences("first line\n   then #product", { channel })).toBe(
    `first line\n   then ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("HTML-looking lines are prose, the way the renderer shows them", () => {
  // The renderer escapes `<` before it parses, so a line opening with a tag is not an HTML block
  // there; the recognizer reads the same structure, so the references on those lines resolve.
  const body = "<details>\n@ada see #product\n</details>";
  expect(messageReferenceCandidates(body)).toEqual({
    handles: ["ada"],
    taskNumbers: [],
    channelNames: ["product"],
    threads: [],
  });
  const resolution = resolveMentionTargets(messageReferenceCandidates(body).handles, [ADA]);
  expect(resolveMessageReferences(body, { mention: resolution.target, channel })).toBe(
    `<details>\n<@human:${ADA.id}> see ${channelReferenceToken(PRODUCT.id, "product")}\n</details>`,
  );
  expect(
    resolveMessageReferences("hi <b>@ada</b> and a < b #product", {
      mention: resolution.target,
      channel,
    }),
  ).toBe(`hi <b><@human:${ADA.id}></b> and a < b ${channelReferenceToken(PRODUCT.id, "product")}`);
});

test("an @mention in a link's label is part of the link, not a mention", () => {
  const { handles } = messageReferenceCandidates("[ask @ada](https://example.com) or @ada");
  const resolution = resolveMentionTargets(handles, [ADA]);
  expect(
    resolveMessageReferences("[ask @ada](https://example.com) or @ada", {
      mention: resolution.target,
    }),
  ).toBe(`[ask @ada](https://example.com) or <@human:${ADA.id}>`);
});

test("a thread reference `#name:shortid` stays text as a whole", () => {
  for (const body of [
    "#product:deadbeef",
    "#product:abc123",
    `#product:${HELPER.id}`,
    "see #PRODUCT:DEADBEEF.",
  ])
    expect(resolveMessageReferences(body, { channel })).toBe(body);
  // A colon followed by anything that is not a message id leaves the channel reference alone.
  expect(resolveMessageReferences("#product: done", { channel })).toBe(
    `${channelReferenceToken(PRODUCT.id, "product")}: done`,
  );
  expect(resolveMessageReferences("#product:abc", { channel })).toBe(
    `${channelReferenceToken(PRODUCT.id, "product")}:abc`,
  );
});

// Thread references: `#name:` and a top-level message id of that channel.

/** Two top-level messages of `#product`: one whose id alone starts `abcdef`, and two sharing the
 * prefix `0123456` so that a six- or seven-character prefix names both. */
const ROOT = "abcdef12-3456-4789-8abc-def012345678";
const TWIN_A = "01234567-0000-4000-8000-000000000001";
const TWIN_B = "0123456f-0000-4000-8000-000000000002";
const PRODUCT_ROOTS = [ROOT, TWIN_A, TWIN_B];
/** The server's answer, in the lookup's shape: the channel by name, then the one top-level message
 * of that channel whose id the anchor names (a prefix, or the whole id); ambiguous names nothing. */
const thread: MessageReferenceLookup["thread"] = (name, anchor) => {
  const found = channel(name);
  if (!found) return undefined;
  const roots = (found.id === PRODUCT.id ? PRODUCT_ROOTS : []).filter((id) =>
    id.startsWith(anchor),
  );
  return roots.length === 1
    ? { channelId: found.id, rootId: roots[0]!, name: found.name }
    : undefined;
};
const rootToken = threadReferenceToken(PRODUCT.id, ROOT, "product");

test("a thread reference naming one top-level message of a channel becomes a thread token", () => {
  for (const written of [
    "#product:abcdef",
    "#product:abcdef1",
    "#product:abcdef12",
    `#product:${ROOT}`,
  ])
    expect(resolveMessageReferences(`see ${written}.`, { channel, thread })).toBe(
      `see ${rootToken}.`,
    );
});

test("a thread reference matches the channel name and the id in any case", () => {
  expect(resolveMessageReferences("#PRODUCT:ABCDEF12", { channel, thread })).toBe(rootToken);
  expect(resolveMessageReferences(`#Product:${ROOT.toUpperCase()}`, { channel, thread })).toBe(
    rootToken,
  );
});

test("an unresolved thread reference stays text as a whole, and its #name is never a channel", () => {
  for (const body of [
    // No such message in the channel.
    "#product:deadbeef",
    // A prefix two messages share.
    "#product:012345",
    "#product:0123456",
    // No such channel, and a name no channel could have.
    "#nope:abcdef12",
    "#产品:abcdef12",
  ])
    expect(resolveMessageReferences(body, { channel, thread })).toBe(body);
  // A prefix only one of the two has resolves.
  expect(resolveMessageReferences("#product:01234567", { channel, thread })).toBe(
    threadReferenceToken(PRODUCT.id, TWIN_A, "product"),
  );
});

test("a thread reference sits next to text in any script, with no boundary needed", () => {
  expect(resolveMessageReferences("去#product:abcdef12看看", { channel, thread })).toBe(
    `去${rootToken}看看`,
  );
  expect(resolveMessageReferences("见 #product:abcdef12。", { channel, thread })).toBe(
    `见 ${rootToken}。`,
  );
});

test("a thread reference is read before the channel it names, in code or a link never", () => {
  expect(resolveMessageReferences("#product and #product:abcdef12", { channel, thread })).toBe(
    `${channelReferenceToken(PRODUCT.id, "product")} and ${rootToken}`,
  );
  for (const body of [
    "`#product:abcdef12`",
    "```\n#product:abcdef12\n```",
    "[see #product:abcdef12](https://example.com)",
    "https://example.com/#product:abcdef12",
    "\\#product:abcdef12",
  ])
    expect(resolveMessageReferences(body, { channel, thread })).toBe(body);
});

test("thread candidates list each channel name and id once, lower-cased, outside code", () => {
  expect(
    messageReferenceCandidates(
      "#Product:ABCDEF12 #product:abcdef12 `#random:deadbeef` #产品:abcdef12 #random:012345",
    ).threads,
  ).toEqual([
    { name: "product", anchor: "abcdef12" },
    { name: "random", anchor: "012345" },
  ]);
});

test("a `task #N` is read as the task before its `#N` could name a channel", () => {
  expect(resolveMessageReferences("task #132", { channel, task: (n) => n === 132 })).toBe(
    taskReferenceToken(132),
  );
  // Even when N names no task, the words `task #N` are a task reference and never a channel.
  expect(resolveMessageReferences("task #132", { channel, task: () => false })).toBe("task #132");
  // A bare `#132` is a channel reference when a channel has that name.
  expect(resolveMessageReferences("#132", { channel })).toBe(
    channelReferenceToken(DIGITS.id, "132"),
  );
});

// Bare `#N`: a task of the conversation first, then a channel of that name.

const task132 = (number: number) => number === 132;

test("a bare #N naming a task of the conversation becomes a task token; any other #N stays text", () => {
  expect(resolveMessageReferences("就是 #132）。先看 #734", { task: task132, channel })).toBe(
    `就是 ${taskReferenceToken(132)}）。先看 #734`,
  );
});

test("a bare #N is a task before it is a channel of the same name", () => {
  // Channel `132` exists; task 132 does too, so the reference is the task.
  expect(resolveMessageReferences("#132", { task: task132, channel })).toBe(
    taskReferenceToken(132),
  );
  // With no task 132 it falls through to the channel called `132`, and with neither it is text.
  expect(resolveMessageReferences("#132", { task: () => false, channel })).toBe(
    channelReferenceToken(DIGITS.id, "132"),
  );
  expect(resolveMessageReferences("#132", { task: () => false })).toBe("#132");
});

test("a bare #N lists the number as a task candidate and as a channel name", () => {
  expect(messageReferenceCandidates("#68 on its own")).toEqual({
    handles: [],
    taskNumbers: [68],
    channelNames: ["68"],
    threads: [],
  });
});

test("a bare #N needs a boundary before it, no leading zero, and no word character after it", () => {
  for (const body of ["issues/#132", "word#132", "#1320", "#132a", "#0132", "#132_x"])
    expect(resolveMessageReferences(body, { task: task132 })).toBe(body);
  // Punctuation or another script right after the number ends it.
  expect(resolveMessageReferences("(#132), #132。#132的问题", { task: task132 })).toBe(
    `(${taskReferenceToken(132)}), ${taskReferenceToken(132)}。${taskReferenceToken(132)}的问题`,
  );
  // Emphasis before the `#` is markup, not a word character.
  expect(resolveMessageReferences("**see**#132", { task: task132 })).toBe(
    `**see**${taskReferenceToken(132)}`,
  );
});

test("a channel named by the whole #name run wins over a task that is only its number", () => {
  const plan = { id: "66666666-6666-4666-8666-666666666666", name: "132-plan" };
  const withPlan = (name: string) => (name === plan.name ? plan : channel(name));
  expect(resolveMessageReferences("#132-plan", { task: task132, channel: withPlan })).toBe(
    channelReferenceToken(plan.id, "132-plan"),
  );
  // No such channel: the number is still the task, and the rest of the run stays as written.
  expect(resolveMessageReferences("#132-Plan", { task: task132, channel })).toBe(
    `${taskReferenceToken(132)}-Plan`,
  );
  expect(messageReferenceCandidates("#132-Plan")).toEqual({
    handles: [],
    taskNumbers: [132],
    channelNames: ["132-plan"],
    threads: [],
  });
});

test("an escape later in a bare #N's run keeps the task; only the channel reading needs the whole run", () => {
  const underscored = { id: "77777777-7777-4777-8777-777777777777", name: "132-_b_" };
  const withUnderscored = (name: string) =>
    name === underscored.name ? underscored : channel(name);
  // The number is written exactly, so it is still the task; the escaped rest stays as written, and
  // the channel the unescaped run would name is not read.
  expect(
    resolveMessageReferences("see #132-\\_b\\_ now", { task: task132, channel: withUnderscored }),
  ).toBe(`see ${taskReferenceToken(132)}-\\_b\\_ now`);
  expect(messageReferenceCandidates("#132-\\_b\\_")).toEqual({
    handles: [],
    taskNumbers: [132],
    channelNames: [],
    threads: [],
  });
  // With no such task the run stays byte-for-byte.
  expect(
    resolveMessageReferences("#132-\\_b\\_", { task: () => false, channel: withUnderscored }),
  ).toBe("#132-\\_b\\_");
});

test("a bare #N in code, a link, a URL, an escape or a thread reference is never a reference", () => {
  for (const body of [
    "`#132`",
    "```\n#132\n```",
    "[see #132](https://example.com)",
    "https://github.com/org/repo/pull/7#132",
    "<https://example.com/#132>",
    "\\#132",
    "#132:deadbeef",
  ])
    expect(resolveMessageReferences(body, { task: task132, channel })).toBe(body);
});

test("`task #N` keeps the whole phrase; a bare #N after it is read on its own", () => {
  expect(
    resolveMessageReferences("task #132 and #132", { task: task132, channel: () => undefined }),
  ).toBe(`${taskReferenceToken(132)} and ${taskReferenceToken(132)}`);
});

test("mentions, tasks and channels resolve together in one pass", () => {
  const { handles } = messageReferenceCandidates("@ada see task #7 in #product");
  const resolution = resolveMentionTargets(handles, [ADA]);
  expect(
    resolveMessageReferences("@ada see task #7 in #product", {
      mention: resolution.target,
      task: (n) => n === 7,
      channel,
    }),
  ).toBe(
    `<@human:${ADA.id}> see ${taskReferenceToken(7)} in ${channelReferenceToken(PRODUCT.id, "product")}`,
  );
});

test("messageReferenceCandidates lists what a sender could mean, outside code, URLs and thread refs", () => {
  expect(
    messageReferenceCandidates(
      "@ada task #68 #Product #product `#code` task #70 #product:deadbeef https://x.io/#url @ada",
    ),
  ).toEqual({
    handles: ["ada"],
    taskNumbers: [68, 70],
    channelNames: ["product"],
    threads: [{ name: "product", anchor: "deadbeef" }],
  });
});

test("only a #name a channel could be called is a channel candidate", () => {
  // `product频道` breaks the channel-name grammar, so it is never looked up; the result is the same.
  expect(messageReferenceCandidates("#product频道, #fff and #68").channelNames).toEqual([
    "fff",
    "68",
  ]);
  expect(resolveMessageReferences("#product频道", { channel })).toBe("#product频道");
});

test("a body with no @ or # is returned as written", () => {
  const body = "plain <b>text</b> & more";
  expect(messageReferenceCandidates(body)).toEqual({
    handles: [],
    taskNumbers: [],
    channelNames: [],
    threads: [],
  });
  expect(resolveMessageReferences(body, { channel })).toBe(body);
});

// Container syntax the parser drops from continuation lines: a quote's `>` markers.

const product = channelReferenceToken(PRODUCT.id, "product");
const random = channelReferenceToken(RANDOM.id, "random");
const ada = `<@human:${ADA.id}>`;
const quoted = (body: string) => {
  const resolution = resolveMentionTargets(messageReferenceCandidates(body).handles, [ADA]);
  return resolveMessageReferences(body, { mention: resolution.target, channel });
};

test("references on every line of a multi-line quote resolve", () => {
  expect(quoted("> quote #product\n> more #random")).toBe(`> quote ${product}\n> more ${random}`);
  expect(quoted("> @ada line one\n> line two #product")).toBe(
    `> ${ada} line one\n> line two ${product}`,
  );
  expect(messageReferenceCandidates("> @ada line one\n> line two #product").handles).toEqual([
    "ada",
  ]);
});

test("a lazy continuation line of a quote resolves", () => {
  expect(quoted("> q1\n> q2\n@ada what about #product")).toBe(
    `> q1\n> q2\n${ada} what about ${product}`,
  );
});

test("a nested quote, an indented marker and a quote in a list item resolve", () => {
  expect(quoted("> > nested #product\n> > more #random")).toBe(
    `> > nested ${product}\n> > more ${random}`,
  );
  expect(quoted("> a\n   >   b #product")).toBe(`> a\n   >   b ${product}`);
  expect(quoted("- a\n  > q #product\n  > r #random")).toBe(
    `- a\n  > q ${product}\n  > r ${random}`,
  );
});

test("a reply-to-selection quote keeps its references", () => {
  const body = `${formatSelectionQuote({ author: "Ada", time: "10:00" }, "@ada see #product\nand #random")}\n\nreply #product`;
  expect(quoted(body)).toBe(
    `> **Ada** 10:00:\n> ${ada} see ${product}\n> and ${random}\n\nreply ${product}`,
  );
});

test("list continuation lines and table cells need no marker handling", () => {
  expect(quoted("- item #product\n  continued #random")).toBe(
    `- item ${product}\n  continued ${random}`,
  );
  expect(quoted("1. item\n   more #product")).toBe(`1. item\n   more ${product}`);
  expect(quoted("| a |\n|---|\n| #product |\n| x #random |")).toBe(
    `| a |\n|---|\n| ${product} |\n| x ${random} |`,
  );
});

test("a continuation line's leading `>` is a marker only as far as the line then aligns", () => {
  // An escaped `\\>` after the marker is content.
  expect(quoted("> a\n> \\> b #product")).toBe(`> a\n> \\> b ${product}`);
  // A lazy line of an unquoted paragraph keeps its `>` as content.
  expect(quoted("a\n    > b #product")).toBe(`a\n    > b ${product}`);
});

// Text a GFM autolink splits off: the new nodes carry no source position.

test("a reference next to a bare email or URL inside emphasis resolves", () => {
  expect(quoted("_see #product x@y.io_")).toBe(`_see ${product} x@y.io_`);
  expect(quoted("_#product a@b.com and #random_")).toBe(`_${product} a@b.com and ${random}_`);
  expect(quoted("_&lt; #product a@b.com_")).toBe(`_&lt; ${product} a@b.com_`);
  expect(quoted("*a https://x.io/#random b #product*")).toBe(
    `*a https://x.io/#random b ${product}*`,
  );
  expect(quoted("_@ada see task #5 x@y.io_")).toBe(`_${ada} see task #5 x@y.io_`);
  expect(resolveMessageReferences("_see task #5 x@y.io_", { task: (number) => number === 5 })).toBe(
    `_see ${taskReferenceToken(5)} x@y.io_`,
  );
});

// Mentions (the resolution rules the tokenizer carries over unchanged).

test("replaceMentionTokens round-trips the stored mention tokens", () => {
  const { body, mentions } = storedBody("ping @ada and @helper", [ADA, HELPER]);
  expect(body).toBe(`ping <@human:${ADA.id}> and <@agent:${HELPER.id}>`);
  expect(mentions).toEqual([ADA, HELPER]);
  const handleByKey = new Map([
    [`user:${ADA.id}`, "@ada"],
    [`agent:${HELPER.id}`, "@helper"],
  ]);
  expect(replaceMentionTokens(body, (type, id) => handleByKey.get(`${type}:${id}`))).toBe(
    "ping @ada and @helper",
  );
});

test("unresolved handles and code spans stay as written", () => {
  const body = "hey @ada, `@ada` in code, @nobody\n```\n@ada fenced\n```";
  const { body: normalized, mentions } = storedBody(body, [ADA]);
  expect(normalized).toBe(
    `hey <@human:${ADA.id}>, \`@ada\` in code, @nobody\n\`\`\`\n@ada fenced\n\`\`\``,
  );
  expect(mentions).toEqual([ADA]);
});

test("bindings resolve, and a binding that matches no target is ignored", () => {
  const { body, mentions } = storedBody(
    "taking this",
    [ADA, HELPER],
    [
      { type: "agent", id: HELPER.id, name: "helper" },
      { type: "user", id: "99999999-9999-4999-8999-999999999999", name: "ghost" },
    ],
  );
  expect(body).toBe("taking this");
  expect(mentions).toEqual([HELPER]);
});

test("a bound handle's plain-text occurrences are rewritten", () => {
  const { body } = storedBody(
    "@helper take it, @helper?",
    [HELPER],
    [{ type: "agent", id: HELPER.id, name: "helper" }],
  );
  expect(body).toBe(`<@agent:${HELPER.id}> take it, <@agent:${HELPER.id}>?`);
});

test("the Agent wins a handle shared with a User", () => {
  const frankUser = {
    key: "member-frank-user",
    type: "user" as const,
    id: ADA.id,
    handle: "frank",
  };
  const frankAgent = {
    key: "member-frank-agent",
    type: "agent" as const,
    id: HELPER.id,
    handle: "frank",
  };
  const { body, mentions } = storedBody("hey @frank", [frankUser, frankAgent]);
  expect(mentions).toEqual([frankAgent]);
  expect(body).toBe(`hey <@agent:${HELPER.id}>`);
});

// Tasks (the resolution rules the tokenizer carries over unchanged).

test("task candidates are prose references outside code, deduped in first-seen order", () => {
  const body = "pairs with task #68 and task #70, again task #68, and `task #99` in code";
  expect(messageReferenceCandidates(body).taskNumbers).toEqual([68, 70]);
});

test("a longer word before #N is not the words `task #N`", () => {
  expect(resolveMessageReferences("mytask #5", { task: (number) => number === 5 })).toBe(
    `mytask ${taskReferenceToken(5)}`,
  );
  expect(messageReferenceCandidates("task #680").taskNumbers).toEqual([680]);
});

test("the word task is matched case-insensitively", () => {
  expect(messageReferenceCandidates("Task #5").taskNumbers).toEqual([5]);
});

test("only numbers that name a real task are tokenized", () => {
  expect(
    resolveMessageReferences("task #68 and task #999 and task #70", {
      task: (number) => number === 68 || number === 70,
    }),
  ).toBe(`${taskReferenceToken(68)} and task #999 and ${taskReferenceToken(70)}`);
});

test("task references inside code spans stay byte-for-byte", () => {
  const source = "see `task #68` and\n```\ntask #68\n```\nand task #68";
  expect(resolveMessageReferences(source, { task: () => true })).toBe(
    `see \`task #68\` and\n\`\`\`\ntask #68\n\`\`\`\nand ${taskReferenceToken(68)}`,
  );
});

test("replaceTaskReferenceTokens round-trips a stored task token", () => {
  const body = resolveMessageReferences("refer to task #7", { task: () => true });
  expect(replaceTaskReferenceTokens(body, (number) => `task #${number}`)).toBe("refer to task #7");
});
