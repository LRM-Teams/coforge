import { expect, test } from "bun:test";
import { nameToSlug } from "#src/lib/slug";
import { nameToWorkspaceSlug } from "#src/features/workspaces/workspace-slug";

test("nameToSlug turns spaces and punctuation into single hyphens", () => {
  expect(nameToSlug("My Great Project!!", 100)).toBe("my-great-project");
  expect(nameToSlug("a__b   c...d", 100)).toBe("a-b-c-d");
});

test("nameToSlug lowercases uppercase letters", () => {
  expect(nameToSlug("ACME Rocket", 100)).toBe("acme-rocket");
});

test("nameToSlug trims leading and trailing separators", () => {
  expect(nameToSlug("  --Launch Plan--  ", 100)).toBe("launch-plan");
  expect(nameToSlug("###", 100)).toBe("");
});

test("nameToSlug returns an empty string for a CJK-only name", () => {
  expect(nameToSlug("项目名称", 100)).toBe("");
});

test("nameToSlug cuts to maxLength without leaving a trailing hyphen", () => {
  expect(nameToSlug("abcdefgh", 4)).toBe("abcd");
  expect(nameToSlug("abc def ghij", 7)).toBe("abc-def");
  // The cut itself lands exactly on a separator run, which must not survive.
  expect(nameToSlug("abc def", 4)).toBe("abc");
});

test("nameToWorkspaceSlug shares the nameToSlug implementation at a 48 character limit", () => {
  expect(nameToWorkspaceSlug("My Great Workspace")).toBe("my-great-workspace");
  expect(nameToWorkspaceSlug("项目名称")).toBe("");
  expect(nameToWorkspaceSlug("x".repeat(60))).toBe("x".repeat(48));
});
