import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards the highlight on the row a position jump lands on (#131: "点击以后，saved 的消息稍微有个高亮
 * 的背景持续几秒").
 *
 * A `#message-<id>` deep link gets that highlight for free: the message row carries `target:` utility
 * variants, and the browser applies them while the location hash points at the element. The Saved
 * view's jump deliberately carries **no** hash (#713 — a hash naming a thread reply is promoted into
 * `threadRootId` and would auto-open the thread pane), so the pane has to apply the very same
 * treatment itself, by id and for a bounded moment (`JUMP_HIGHLIGHT_MS`).
 *
 * Two things can regress without anyone noticing: the two treatments drifting apart (the landed row
 * looking like a different kind of highlight than the deep link's), and one of the two landing paths
 * — the row already in the window, or the pending pass after an "around" read — forgetting to flash.
 * Both are asserted here, which is what a suite that only renders server-side can actually pin.
 */
const REPO_ROOT = join(import.meta.dir, "..");
const MESSAGE_ROW = join(REPO_ROOT, "src/features/conversations/message-row.tsx");
const CONVERSATION_PANE = join(REPO_ROOT, "src/features/conversations/direct-conversation.tsx");

test("the landed row wears exactly the classes the :target treatment uses", async () => {
  const source = await readFile(MESSAGE_ROW, "utf8");
  const targetLine = source.split("\n").find((line) => line.includes("target:bg-active"));
  expect(targetLine).toBeDefined();
  const deepLinkClasses = (targetLine as string)
    .match(/target:[^\s"]+/g)
    ?.map((token) => token.replace(/^target:/, ""))
    .sort();
  expect(deepLinkClasses?.length).toBeGreaterThan(0);
  const landedClasses = source
    .match(/highlighted && "([^"]+)"/)?.[1]
    .split(/\s+/)
    .sort();
  expect(landedClasses).toBeDefined();
  expect(landedClasses).toEqual(deepLinkClasses);
});

test("both landing paths flash the row, and the duration is named", async () => {
  const source = await readFile(CONVERSATION_PANE, "utf8");
  // One call where the message is already loaded (`showMessage`) and one in the layout effect that
  // finishes a pending `onLoadMessageAround` pass — dropping either leaves one landing path without
  // a highlight, which is exactly the half-fixed state a reviewer would miss by eye.
  expect(source.match(/flashMessageRow\(messageId\)/g) ?? []).toHaveLength(2);
  // A magic duration in the timer would drift from the comment and the test above.
  expect(source).toMatch(/const JUMP_HIGHLIGHT_MS = \d+;/);
  expect(source).toContain("}, JUMP_HIGHLIGHT_MS);");
});
