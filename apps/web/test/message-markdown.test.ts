import { expect, test } from "bun:test";

import {
  CHANNEL_CHIP_CLASS,
  MENTION_CHIP_AGENT_CLASS,
  MENTION_CHIP_CLASS,
  MENTION_CHIP_SELF_CLASS,
  TASK_CHIP_CLASS,
  TASK_CHIP_LINK_CLASS,
  type ChipMention,
  mentionHandlesByToken,
  patternAlternation,
  rehypeReferenceChips,
} from "#src/features/conversations/message-markdown";
import { escapeLiteralHtml } from "#src/lib/message-syntax";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";
const AGENT_TOKEN = `<@agent:${UUID}>`;
const HUMAN_TOKEN = `<@human:${OTHER_UUID}>`;

/** Runs the chip pass over a tree shaped like the one `rehype-sanitize` leaves behind. */
function chipify(
  children: unknown[],
  options: {
    handles?: Map<string, ChipMention>;
    viewerHandle?: string;
    plain?: Map<string, ChipMention>;
  } = {},
) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({
    mentions: options.handles ?? new Map(),
    viewerHandle: options.viewerHandle,
    plainMentions: options.plain,
  })(tree);
  return tree as { children: Array<Record<string, unknown>> };
}

function text(value: string) {
  return { type: "text", value };
}

function paragraph(children: unknown[]) {
  return { type: "element", tagName: "p", properties: {}, children };
}

test("an HTML-looking tag outside code is escaped so it renders as literal text", () => {
  expect(escapeLiteralHtml(`<div class="x">raw</div>`)).toBe(`&lt;div class="x">raw&lt;/div>`);
});

test("a closing or unknown tag is escaped rather than dropped", () => {
  expect(escapeLiteralHtml("</div>")).toBe("&lt;/div>");
  expect(escapeLiteralHtml("<3 heart")).toBe("&lt;3 heart");
});

test("a lone less-than in ordinary prose is escaped", () => {
  expect(escapeLiteralHtml("a < b and 3 < 4")).toBe("a &lt; b and 3 &lt; 4");
});

test("an ampersand is left as written so bare URL query strings survive", () => {
  expect(escapeLiteralHtml("AT&T")).toBe("AT&T");
});

test("an ampersand inside a URL is not escaped into the link text", () => {
  const body = "https://example.com/path?a=1&b=2";
  expect(escapeLiteralHtml(body)).toBe(body);
});

test("a GFM autolink keeps its angle brackets so it still links", () => {
  expect(escapeLiteralHtml("see <https://example.com> now")).toBe("see <https://example.com> now");
});

test("a mailto autolink keeps its angle brackets", () => {
  expect(escapeLiteralHtml("<mailto:ada@example.com>")).toBe("<mailto:ada@example.com>");
});

test("a mention token keeps its angle brackets so it can still become a chip", () => {
  expect(escapeLiteralHtml(`hi ${AGENT_TOKEN} there`)).toBe(`hi ${AGENT_TOKEN} there`);
});

test("an inline code span passes through byte-for-byte", () => {
  const body = "inline `<b>x</b> & AT&T` here";
  expect(escapeLiteralHtml(body)).toBe(body);
});

test("a fenced code block passes through byte-for-byte", () => {
  const body = "```html\n<div>in fence</div> & <span>\n```";
  expect(escapeLiteralHtml(body)).toBe(body);
});

test("escaping outside code never disturbs the code span inside the same body", () => {
  expect(escapeLiteralHtml("`a < b` but <div>")).toBe("`a < b` but &lt;div>");
});

test("a bare URL keeps its query string intact for GFM autolinking", () => {
  const body = "see https://example.com/path?a=1&b=2#frag for details";
  expect(escapeLiteralHtml(body)).toBe(body);
});

test("escaping leaves a code span inside the same body untouched", () => {
  const body = "<div>a</div>\n\n`code <x>`\n\ntext";
  expect(escapeLiteralHtml(body)).toContain("`code <x>`");
});

test("mention rows are keyed by the token spelling, lower-cased", () => {
  const handles = mentionHandlesByToken([
    {
      kind: "agent",
      actorId: UUID.toUpperCase(),
      handle: "scout",
      label: "scout",
    },
    { kind: "user", actorId: OTHER_UUID, handle: "ada", label: "ada" },
  ]);
  expect(handles.get(`agent:${UUID.toLowerCase()}`)).toEqual({
    handle: "scout",
    label: "scout",
    agentId: UUID.toUpperCase(),
  });
  // A human mention carries no agentId: there is no human profile panel to open.
  expect(handles.get(`user:${OTHER_UUID.toLowerCase()}`)).toEqual({
    handle: "ada",
    label: "ada",
    agentId: undefined,
  });
});

test("a resolved token becomes a chip carrying the handle", () => {
  const tree = chipify([paragraph([text(`hi ${AGENT_TOKEN} there`)])], {
    handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]),
  });
  const children = tree.children[0]!.children as Array<Record<string, unknown>>;
  expect(children[0]).toEqual(text("hi "));
  expect(children[1]).toMatchObject({ tagName: "span", children: [text("@scout")] });
  expect(children[2]).toEqual(text(" there"));
});

test("an Agent chip carries its Agent id and the clickable class", () => {
  const tree = chipify([paragraph([text(AGENT_TOKEN)])], {
    handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]),
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  const properties = chip.properties as { className: string[]; "data-mention-agent-id"?: string };
  expect(properties.className).toContain(MENTION_CHIP_AGENT_CLASS);
  expect(properties["data-mention-agent-id"]).toBe(UUID);
});

test("a chip uses the ordinary brand fill by default", () => {
  const tree = chipify([paragraph([text(AGENT_TOKEN)])], {
    handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]),
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  const className = (chip.properties as { className: string[] }).className;
  // The agent variant appends its own class after the base chip classes.
  expect(className.slice(0, MENTION_CHIP_CLASS.split(" ").length)).toEqual(
    MENTION_CHIP_CLASS.split(" "),
  );
});

test("a mention of the viewing user gets the stronger treatment and stays a plain highlight", () => {
  const tree = chipify([paragraph([text(HUMAN_TOKEN)])], {
    handles: new Map([[`user:${OTHER_UUID}`, { handle: "ada", label: "ada" }]]),
    viewerHandle: "ada",
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  const properties = chip.properties as { className: string[]; "data-mention-agent-id"?: string };
  expect(properties.className).toEqual(MENTION_CHIP_SELF_CLASS.split(" "));
  // A human mention is never clickable.
  expect(properties.className).not.toContain(MENTION_CHIP_AGENT_CLASS);
  expect(properties["data-mention-agent-id"]).toBeUndefined();
});

test("a mention of someone else does not get the viewer treatment", () => {
  const tree = chipify([paragraph([text(HUMAN_TOKEN)])], {
    handles: new Map([[`user:${OTHER_UUID}`, { handle: "ada", label: "ada" }]]),
    viewerHandle: "grace",
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  expect((chip.properties as { className: string[] }).className).toEqual(
    MENTION_CHIP_CLASS.split(" "),
  );
});

test("an unresolvable token degrades to its raw text rather than a phantom chip", () => {
  const tree = chipify([paragraph([text(AGENT_TOKEN)])], { handles: new Map() });
  const children = tree.children[0]!.children as Array<Record<string, unknown>>;
  expect(children).toEqual([text(AGENT_TOKEN)]);
});

test("a token inside an inline code element is never chipped", () => {
  const tree = chipify(
    [
      paragraph([
        {
          type: "element",
          tagName: "code",
          properties: {},
          children: [text(AGENT_TOKEN)],
        },
      ]),
    ],
    { handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]) },
  );
  const code = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  expect(code.children).toEqual([text(AGENT_TOKEN)]);
});

test("a token inside a fenced code block is never chipped", () => {
  const tree = chipify(
    [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: [text(AGENT_TOKEN)],
          },
        ],
      },
    ],
    { handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]) },
  );
  const pre = tree.children[0]!;
  const code = (pre.children as Array<Record<string, unknown>>)[0]!;
  expect(code.children).toEqual([text(AGENT_TOKEN)]);
});

test("chips are found in nested structures such as a list item", () => {
  const tree = chipify(
    [
      {
        type: "element",
        tagName: "ul",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "li",
            properties: {},
            children: [paragraph([text(AGENT_TOKEN)])],
          },
        ],
      },
    ],
    { handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]) },
  );
  const item = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  const p = (item.children as Array<Record<string, unknown>>)[0]!;
  expect((p.children as Array<Record<string, unknown>>)[0]).toMatchObject({ tagName: "span" });
});

test("two tokens in one text node both become chips with their own handles", () => {
  const tree = chipify([paragraph([text(`${AGENT_TOKEN} and ${HUMAN_TOKEN}`)])], {
    handles: new Map([
      [`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }],
      [`user:${OTHER_UUID}`, { handle: "ada", label: "ada" }],
    ]),
  });
  const children = tree.children[0]!.children as Array<Record<string, unknown>>;
  expect(children).toEqual([
    expect.objectContaining({ tagName: "span", children: [text("@scout")] }),
    text(" and "),
    expect.objectContaining({ tagName: "span", children: [text("@ada")] }),
  ]);
});

test("text without any token is left untouched", () => {
  const tree = chipify([paragraph([text("nothing to see")])], {
    handles: new Map([[`agent:${UUID}`, { handle: "scout", label: "scout", agentId: UUID }]]),
  });
  expect((tree.children[0]!.children as Array<Record<string, unknown>>)[0]).toEqual(
    text("nothing to see"),
  );
});

test("a plain @handle naming a member becomes a chip with the display label", () => {
  const tree = chipify([paragraph([text("ping @andong3 please")])], {
    plain: new Map([["andong3", { handle: "andong3", label: "andong3" }]]),
  });
  const children = tree.children[0]!.children as Array<Record<string, unknown>>;
  expect(children).toHaveLength(3);
  expect(children[1]!.children).toEqual([{ type: "text", value: "@andong3" }]);
  expect(
    ((children[1]!.properties as Record<string, unknown>).className as string[]).some((cls) =>
      MENTION_CHIP_CLASS.split(" ").includes(cls),
    ),
  ).toBe(true);
});

test("a plain @handle renders the member's display label, not the handle", () => {
  const tree = chipify([paragraph([text("ping @ada please")])], {
    plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]),
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[1]!;
  expect(chip.children).toEqual([{ type: "text", value: "@Ada Lovelace" }]);
});

test("a plain @handle for an unknown member stays literal text", () => {
  const source = "ping @stranger please";
  const tree = chipify([paragraph([text(source)])], {
    plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]),
  });
  expect((tree.children[0]!.children as Array<Record<string, unknown>>)[0]!.value).toBe(source);
});

test("an email address is never chipped as a plain mention", () => {
  const source = "mail me at ada@example.com ok";
  const tree = chipify([paragraph([text(source)])], {
    plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]),
  });
  expect((tree.children[0]!.children as Array<Record<string, unknown>>)[0]!.value).toBe(source);
});

test("a plain handle inside an unresolved token is not double-chipped", () => {
  const source = `see <@agent:${UUID}> end`;
  const tree = chipify([paragraph([text(source)])], {
    plain: new Map([["agent", { handle: "agent", label: "Agent" }]]),
  });
  // The token has no resolved row, so it stays literal — including its inner `@agent` spelling.
  expect(
    (tree.children[0]!.children as Array<Record<string, unknown>>)
      .map((child) => child.value)
      .join(""),
  ).toBe(source);
});

test("a plain handle inside code is left alone", () => {
  const source = "run `@ada --help` first";
  const tree = chipify(
    [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [{ type: "element", tagName: "code", properties: {}, children: [text(source)] }],
      },
    ],
    { plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]) },
  );
  expect(
    (
      (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!.children as Array<
        Record<string, unknown>
      >
    )[0]!.value,
  ).toBe(source);
});

test("a plain handle of the viewer renders with the self chip class", () => {
  const tree = chipify([paragraph([text("thanks @ada!")])], {
    viewerHandle: "ada",
    plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]),
  });
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[1]!;
  expect(
    ((chip.properties as Record<string, unknown>).className as string[]).some((cls) =>
      MENTION_CHIP_SELF_CLASS.split(" ").includes(cls),
    ),
  ).toBe(true);
});

/** Runs the chip pass over a tree shaped like the sanitized one, for a conversation's tasks. */
function taskChipify(children: unknown[], numbers: ReadonlySet<number> = new Set()) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({ mentions: new Map(), taskNumbers: numbers })(tree);
  return tree as { children: Array<Record<string, unknown>> };
}

test("a task token renders as a number-only chip", () => {
  const tree = taskChipify([paragraph([text("with <@task:68> next")])], new Set([68]));
  const children = tree.children[0]!.children as Array<Record<string, unknown>>;
  expect(children[0]).toEqual(text("with "));
  expect(children[1]).toMatchObject({
    tagName: "span",
    properties: { title: "task #68", "aria-label": "task #68" },
    children: [text("#68")],
  });
  expect(children[2]).toEqual(text(" next"));
});

test("a referenced number known here becomes a clickable chip", () => {
  const tree = taskChipify([paragraph([text("<@task:68>")])], new Set([68]));
  const chip = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  const properties = chip.properties as {
    className: string[];
    "data-task-reference-number"?: number;
  };
  expect(properties.className).toEqual([...TASK_CHIP_CLASS.split(" "), TASK_CHIP_LINK_CLASS]);
  expect(properties["data-task-reference-number"]).toBe(68);
});

test("a task token naming no task of this conversation reads as plain text, with no chip", () => {
  // A token is a claim, checked against the conversation's tasks.
  const tree = taskChipify([paragraph([text("see <@task:999>.")])], new Set([68]));
  expect(tree.children[0]!.children).toEqual([text("see "), text("task #999"), text(".")]);
});

test("a task token or a plain @handle inside a link is text, never a control inside a link", () => {
  const link = (value: string) =>
    paragraph([
      { type: "element", tagName: "a", properties: { href: "/x" }, children: [text(value)] },
    ]);
  const task = taskChipify([link("<@task:68>")], new Set([68]));
  expect((task.children[0]!.children as Array<Record<string, unknown>>)[0]!.children).toEqual([
    text("task #68"),
  ]);
  const plain = chipify([link("ask @ada")], {
    plain: new Map([["ada", { handle: "ada", label: "Ada Lovelace" }]]),
  });
  expect((plain.children[0]!.children as Array<Record<string, unknown>>)[0]!.children).toEqual([
    text("ask @ada"),
  ]);
});

test("a task token inside a code element is never chipped", () => {
  const tree = taskChipify(
    [
      paragraph([
        { type: "element", tagName: "code", properties: {}, children: [text("<@task:68>")] },
      ]),
    ],
    new Set([68]),
  );
  const code = (tree.children[0]!.children as Array<Record<string, unknown>>)[0]!;
  expect(code.children).toEqual([text("<@task:68>")]);
});

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_TOKEN = `<@channel:${CHANNEL_ID}:product>`;

function channelChipify(children: unknown[], currentNames?: ReadonlyMap<string, string>) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({ mentions: new Map(), channelNames: currentNames })(tree);
  return tree as { children: Array<{ children: Array<Record<string, unknown>> }> };
}

test("a channel token keeps its angle brackets through the HTML escape", () => {
  expect(escapeLiteralHtml(`see ${CHANNEL_TOKEN} now`)).toBe(`see ${CHANNEL_TOKEN} now`);
});

test("a channel token becomes a chip carrying the channel id and its current name", () => {
  const tree = channelChipify(
    [paragraph([text(`see ${CHANNEL_TOKEN} now`)])],
    new Map([[CHANNEL_ID, "launch"]]),
  );
  const [before, chip, after] = tree.children[0]!.children;
  expect(before).toEqual(text("see "));
  expect(chip).toMatchObject({
    tagName: "span",
    properties: { className: CHANNEL_CHIP_CLASS.split(" "), "data-channel-id": CHANNEL_ID },
    children: [text("#launch")],
  });
  expect(after).toEqual(text(" now"));
});

test("a channel token whose id the Workspace does not have reads as plain #name, with no link", () => {
  // A token is a claim, checked against the Workspace's channels (closed ones included): an unknown
  // or forged id gets no chip and no link, only the name as text — what typing `#name` gives.
  const tree = channelChipify([paragraph([text(CHANNEL_TOKEN)])], new Map());
  expect(tree.children[0]!.children).toEqual([text("#product")]);
});

test("without a place to navigate from, a channel token reads as plain #name", () => {
  const tree = channelChipify([paragraph([text(`see ${CHANNEL_TOKEN}`)])]);
  expect(tree.children[0]!.children).toEqual([text("see "), text("#product")]);
});

test("a channel token inside a link reads as plain #name, never a link in a link", () => {
  const tree = channelChipify(
    [
      paragraph([
        {
          type: "element",
          tagName: "a",
          properties: { href: "/x" },
          children: [text(CHANNEL_TOKEN)],
        },
      ]),
    ],
    new Map(),
  );
  const link = tree.children[0]!.children[0]!;
  expect(link.children).toEqual([text("#product")]);
});

test("a channel token inside code, and a plain #name anywhere, stay as written", () => {
  const tree = channelChipify(
    [
      paragraph([
        { type: "element", tagName: "code", properties: {}, children: [text(CHANNEL_TOKEN)] },
        text(" and #product"),
      ]),
    ],
    new Map([[CHANNEL_ID, "product"]]),
  );
  const [code, prose] = tree.children[0]!.children;
  expect(code!.children).toEqual([text(CHANNEL_TOKEN)]);
  expect(prose).toEqual(text(" and #product"));
});

test("an alternation reads each match as its own pattern's groups, a `u` pattern included", () => {
  const { pattern, read } = patternAlternation([
    /<@x:(\d+)>/gi,
    /(?<![\p{L}])@(\p{L}+)/gu,
    /#([a-z]+)-(\d+)/g,
  ]);
  const reads = [..."ask @élodie about <@X:5> and #plan-2".matchAll(pattern)].map(read);
  expect(reads).toEqual([
    { index: 1, groups: ["élodie"] },
    { index: 0, groups: ["5"] },
    { index: 2, groups: ["plan", "2"] },
  ]);
});
