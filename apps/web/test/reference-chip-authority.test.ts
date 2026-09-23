import { expect, test } from "bun:test";
import { toHtml } from "hast-util-to-html";
import rehypeSanitize from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  rehypeChannelReferenceChips,
  rehypeTaskReferenceChips,
} from "#src/features/conversations/message-markdown";
import { MESSAGE_REMARK_PLUGINS, escapeLiteralHtml } from "#src/lib/message-syntax";

const PRODUCT = "33333333-3333-4333-8333-333333333333";
const FORGED = "99999999-9999-4999-8999-999999999999";

/** The renderer's pipeline (`message-body.tsx`) through its chip passes, as HTML, for a viewer
 * whose Workspace has one channel (`PRODUCT`, now called `launch`) and a conversation with task 7. */
const rendered = (body: string) =>
  toHtml(
    unified()
      .use(remarkParse)
      .use(MESSAGE_REMARK_PLUGINS)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(rehypeChannelReferenceChips, { currentNames: new Map([[PRODUCT, "launch"]]) })
      .use(rehypeTaskReferenceChips, { numbers: new Set<number>([7]) })
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
