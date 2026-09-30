import { expect, test } from "bun:test";

import {
  renameHistoryTitleMentions,
  renameMentionsInText,
} from "#src/server/auth/username-rename-text.server";

/**
 * A task's history keeps the title as an Agent reads it, with each mention as `@handle` text, so a
 * renamed person's old handle is in those strings. What is a mention there is what is a mention
 * anywhere: the grammar's `MENTION_PATTERN`.
 */

const renamed = new Map([
  ["andong3-d9956ab1", "andong3"],
  ["9lives", "u9lives"],
]);

test("a mention of a renamed person is written with the new name", () => {
  expect(renameMentionsInText("ask @andong3-d9956ab1 and @9lives", renamed)).toBe(
    "ask @andong3 and @u9lives",
  );
  expect(renameMentionsInText("(@9lives), @9lives. @9lives", renamed)).toBe(
    "(@u9lives), @u9lives. @u9lives",
  );
});

test("a handle that only starts with the old one, or an old one followed by a handle character, is not that mention", () => {
  expect(renameMentionsInText("@9lives-x @9livesx @9lives_ @9lives2", renamed)).toBe(
    "@9lives-x @9livesx @9lives_ @9lives2",
  );
  expect(renameMentionsInText("@andong3-d9956ab1x", renamed)).toBe("@andong3-d9956ab1x");
});

test("an @ that is part of a word or another @ is not a mention", () => {
  expect(renameMentionsInText("mail me@9lives, @@9lives", renamed)).toBe(
    "mail me@9lives, @@9lives",
  );
});

test("a mention of anyone else, and text without one, is left as it is", () => {
  expect(renameMentionsInText("@ada and 9lives", renamed)).toBe("@ada and 9lives");
});

test("only the title of an amended event is rewritten, in both its from and to", () => {
  const payload = {
    revision: 2,
    changes: {
      title: { from: "review with @9lives", to: "review with @9lives and @ada" },
      description: { from: "see @9lives", to: "see @9lives too" },
    },
  };

  expect(renameHistoryTitleMentions(payload, renamed)).toEqual({
    revision: 2,
    changes: {
      title: { from: "review with @u9lives", to: "review with @u9lives and @ada" },
      description: { from: "see @9lives", to: "see @9lives too" },
    },
  });
});

test("a payload with no renamed mention in its title has nothing to rewrite", () => {
  expect(
    renameHistoryTitleMentions({ changes: { title: { from: "a", to: "b @ada" } } }, renamed),
  ).toBeUndefined();
  expect(renameHistoryTitleMentions({ from: "todo", to: "done" }, renamed)).toBeUndefined();
  expect(renameHistoryTitleMentions({ changes: { description: {} } }, renamed)).toBeUndefined();
  expect(renameHistoryTitleMentions(null, renamed)).toBeUndefined();
  expect(renameHistoryTitleMentions("text", renamed)).toBeUndefined();
});
