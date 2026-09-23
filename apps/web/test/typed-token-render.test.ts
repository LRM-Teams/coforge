import { expect, test } from "bun:test";
import { toHtml } from "hast-util-to-html";
import rehypeSanitize from "rehype-sanitize";
import remarkRehype from "remark-rehype";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  rehypeChannelReferenceChips,
  rehypeTaskReferenceChips,
} from "#src/features/conversations/message-markdown";
import { readMessageReferences } from "#src/lib/message-references";
import { MESSAGE_REMARK_PLUGINS, escapeLiteralHtml } from "#src/lib/message-syntax";

const FORGED = "99999999-9999-4999-8999-999999999999";

/** Every spelling of a stored channel or task token a sender could type. */
const TYPED = [
  `<@channel:${FORGED}:evil>`,
  `&lt;@channel:${FORGED}:evil>`,
  `\\<@channel:${FORGED}:evil>`,
  `&#60;@channel:${FORGED}:evil>`,
  `&#x3c;@channel:${FORGED}:evil>`,
  `&#X3C;@channel:${FORGED}:evil>`,
  `<@task:7>`,
  `&#60;@task:7>`,
  `\\<@task:7>`,
  `&lt;@task&#58;7&gt;`,
  `> quoted\n> &lt;@channel:${FORGED}:evil>`,
  `**&#60;@task:7>**`,
];

/** The renderer's pipeline (`message-body.tsx`) up to its chip passes, as HTML. */
const chips = (body: string) =>
  toHtml(
    unified()
      .use(remarkParse)
      .use(MESSAGE_REMARK_PLUGINS)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(rehypeChannelReferenceChips, { currentNames: new Map() })
      // No known task numbers: only a stored `<@task:N>` token can become a task chip, never a bare
      // `#N` (that is the render-time task pass, for tasks this conversation really has).
      .use(rehypeTaskReferenceChips, { numbers: new Set<number>() })
      .runSync(
        unified().use(remarkParse).use(MESSAGE_REMARK_PLUGINS).parse(escapeLiteralHtml(body)),
      ),
  );

/** Spellings that decode to a token only after character references are read. */
const SPELLED = [
  `<&#64;channel:${FORGED}:evil>`,
  `&lt;&commat;channel&colon;${FORGED}&colon;evil&gt;`,
  `a <@channel:${FORGED}:evil> b <&#64;channel:${FORGED}:evil2>`,
];

test("each typed spelling would render a chip if it were stored as typed", () => {
  for (const body of TYPED)
    expect(chips(body)).toMatch(/data-channel-id|message-markdown-task-reference/);
});

test("a stored body never renders a channel or task chip the server did not write", () => {
  const chipped = [...TYPED, ...SPELLED]
    .map((body) => readMessageReferences(body).resolve({}))
    .filter((stored) => /data-channel-id|message-markdown-task-reference/.test(chips(stored)));
  expect(chipped).toEqual([]);
});
