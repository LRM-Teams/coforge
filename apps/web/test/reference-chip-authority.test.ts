import { expect, test } from "bun:test";
import { toHtml } from "hast-util-to-html";
import rehypeSanitize from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { rehypeReferenceChips } from "#src/features/conversations/message-markdown";
import { MESSAGE_REMARK_PLUGINS, escapeLiteralHtml } from "#src/lib/message-syntax";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const FORGED = "99999999-9999-4999-8999-999999999999";
const SCOUT = "55555555-5555-4555-8555-555555555555";

/** The renderer's pipeline (`message-body.tsx`) through its chip pass, as HTML, for a viewer whose
 * Workspace has one channel (`PRODUCT`, now called `launch`), a conversation with task 7, and a
 * message that mentions the Agent `SCOUT` (displayed as "Scout #7"). */
const rendered = (body: string) =>
  toHtml(
    unified()
      .use(remarkParse)
      .use(MESSAGE_REMARK_PLUGINS)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(rehypeReferenceChips, {
        mentions: new Map([
          [`agent:${SCOUT}`, { handle: "scout", label: "Scout #7", agentId: SCOUT }],
        ]),
        taskNumbers: new Set<number>([7]),
        channelNames: new Map([[PRODUCT, "launch"]]),
      })
      .runSync(
        unified().use(remarkParse).use(MESSAGE_REMARK_PLUGINS).parse(escapeLiteralHtml(body)),
      ),
  );

test("a channel token backed by the Workspace's channels is a chip under the channel's current name", () => {
  const html = rendered(`see <@channel:${PRODUCT}:product>`);
  expect(html).toContain(`data-channel-id="${PRODUCT}"`);
  expect(html).toContain(">#launch<");
});

test("a channel token with an id the Workspace does not have is plain text, however it is spelled", () => {
  for (const body of [
    `<@channel:${FORGED}:evil>`,
    `&lt;@channel:${FORGED}:evil>`,
    `\\<@channel:${FORGED}:evil>`,
    `&#60;@channel:${FORGED}:evil>`,
    `&#x3c;@channel:${FORGED}:evil>`,
    `<&#64;channel:${FORGED}:evil>`,
    `_<@channel:${FORGED}:evil> a@b.com_`,
    `> quoted\n> &lt;@channel:${FORGED}:evil>`,
  ]) {
    const html = rendered(body);
    expect(html).not.toContain("data-channel-id");
    expect(html).toContain("#evil");
  }
});

test("a task token backed by the conversation's tasks is a chip; any other number is plain text", () => {
  expect(rendered("see <@task:7>")).toContain('data-task-reference-number="7"');
  for (const body of ["<@task:5>", "&#60;@task:5>", "_see <@task:5> x@y.io_"]) {
    const html = rendered(body);
    expect(html).not.toContain("message-markdown-task-reference");
    expect(html).toContain("task #5");
  }
});

test("a bare #N is plain text when rendered, even when it names a task: only a token is a chip", () => {
  // A bare `#N` becomes a token when the message is sent; a body stored before that stays text.
  const html = rendered("see #7 and task #7");
  expect(html).not.toContain("message-markdown-task-reference");
  expect(html).toContain("see #7 and task #7");
});

test("every kind of token is a chip in one body, and a chip's label is never read again", () => {
  const html = rendered(`<@agent:${SCOUT}> moved <@task:7> to <@channel:${PRODUCT}:product>`);
  // The mention's label holds `#7`; it stays the label, with no task chip inside it.
  expect(html).toContain('data-mention-agent-id="55555555-5555-4555-8555-555555555555"');
  expect(html).toContain(">@Scout #7<");
  expect(html.match(/data-task-reference-number/g)).toHaveLength(1);
  expect(html).toContain(`data-channel-id="${PRODUCT}"`);
});

test("inside a link every token reads as its text, and inside code it stays as written", () => {
  const link = rendered(
    `[<@agent:${SCOUT}> <@task:7> <@channel:${PRODUCT}:product>](https://example.com)`,
  );
  expect(link).toContain(">@Scout #7 task #7 #launch</a>");
  const code = rendered(`\`<@task:7> <@channel:${PRODUCT}:product>\``);
  expect(code).toContain(`<code>&#x3C;@task:7> &#x3C;@channel:${PRODUCT}:product></code>`);
});
