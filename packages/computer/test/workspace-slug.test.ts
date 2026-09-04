import { expect, test } from "bun:test";

import { isValidComputerWorkspaceSlug } from "../src/workspace/workspace-slug";

test("accepts lowercase letters, digits, and single hyphens between segments", () => {
  expect(isValidComputerWorkspaceSlug("acme")).toBe(true);
  expect(isValidComputerWorkspaceSlug("acme-inc")).toBe(true);
  expect(isValidComputerWorkspaceSlug("acme-inc-2")).toBe(true);
  expect(isValidComputerWorkspaceSlug("a1b2c3")).toBe(true);
});

test("rejects an empty slug", () => {
  expect(isValidComputerWorkspaceSlug("")).toBe(false);
});

test("rejects uppercase letters", () => {
  expect(isValidComputerWorkspaceSlug("Acme")).toBe(false);
});

test("rejects spaces and other non-slug characters", () => {
  expect(isValidComputerWorkspaceSlug("acme inc")).toBe(false);
  expect(isValidComputerWorkspaceSlug("acme_inc")).toBe(false);
  expect(isValidComputerWorkspaceSlug("acme!")).toBe(false);
});

test("rejects a leading or trailing hyphen", () => {
  expect(isValidComputerWorkspaceSlug("-acme")).toBe(false);
  expect(isValidComputerWorkspaceSlug("acme-")).toBe(false);
});

test("rejects a double hyphen", () => {
  expect(isValidComputerWorkspaceSlug("acme--inc")).toBe(false);
});

test("rejects a slug longer than 48 characters", () => {
  const tooLong = "a".repeat(49);
  expect(isValidComputerWorkspaceSlug(tooLong)).toBe(false);
  expect(isValidComputerWorkspaceSlug("a".repeat(48))).toBe(true);
});
