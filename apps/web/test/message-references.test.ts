import { expect, test } from "bun:test";
import {
  channelReferenceToken,
  replaceMentionTokens,
  replaceTaskReferenceTokens,
  resolveMentionTargets,
  taskReferenceToken,
  type MentionTarget,
} from "@lrm/coforge-sdk/internal";
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
  });
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

test("a bare #68 or a longer word is not a task candidate", () => {
  expect(messageReferenceCandidates("#68 on its own").taskNumbers).toEqual([]);
  expect(messageReferenceCandidates("mytask #5").taskNumbers).toEqual([]);
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
