import { expect, test } from "bun:test";
import { parseDurationSeconds } from "../src/reminder-duration";

test("parses a bare integer and each unit suffix", () => {
  expect(parseDurationSeconds("30")).toBe(30);
  expect(parseDurationSeconds("30s")).toBe(30);
  expect(parseDurationSeconds("5m")).toBe(300);
  expect(parseDurationSeconds("2h")).toBe(7200);
  expect(parseDurationSeconds("1d")).toBe(86400);
});

test("rejects zero, negative, fractional, and malformed literals", () => {
  expect(parseDurationSeconds("0")).toBeNull();
  expect(parseDurationSeconds("0s")).toBeNull();
  expect(parseDurationSeconds("-5")).toBeNull();
  expect(parseDurationSeconds("5.5")).toBeNull();
  expect(parseDurationSeconds("5x")).toBeNull();
  expect(parseDurationSeconds("m5")).toBeNull();
  expect(parseDurationSeconds("")).toBeNull();
  expect(parseDurationSeconds("5 m")).toBeNull();
  expect(parseDurationSeconds("5mm")).toBeNull();
});

test("rejects a literal whose seconds value overflows a safe integer", () => {
  expect(parseDurationSeconds("9007199254740993d")).toBeNull();
});
