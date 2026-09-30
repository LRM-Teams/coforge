import { expect, test } from "bun:test";

import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  SYSTEM_SENDER_LABEL,
} from "#src/features/profiles/person-name";
import { browserSenderName } from "#src/server/conversations/sender-display.server";

// What a person's name may be, wherever they set it: the full name asked at first sign-in and the
// profile's own name are one rule. The server applies it to whatever a form sends, so a name is
// judged here, once, and a page only shows the problem it names.

test("a name is trimmed, and its inner runs of whitespace become one space", () => {
  expect(checkPersonName("  Ada   Lovelace \t")).toEqual({ ok: true, name: "Ada Lovelace" });
  expect(checkPersonName("Ada\nLovelace")).toEqual({ ok: true, name: "Ada Lovelace" });
  // A no-break space is whitespace too.
  expect(checkPersonName("Ada  Lovelace")).toEqual({ ok: true, name: "Ada Lovelace" });
});

test("a name is stored in Unicode normalization form C, so one name is one string", () => {
  // "é" as `e` + combining acute (NFD) and as the single precomposed character (NFC).
  expect(checkPersonName("José")).toEqual({ ok: true, name: "José" });
});

test("a name in any script is accepted", () => {
  expect(checkPersonName("安栋")).toEqual({ ok: true, name: "安栋" });
  expect(checkPersonName("Åsa Nørgaard-O’Neil")).toEqual({
    ok: true,
    name: "Åsa Nørgaard-O’Neil",
  });
  // A zero-width joiner inside a name joins an emoji sequence or shapes a script: it stays.
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  expect(checkPersonName(`Ada ${family}`)).toEqual({ ok: true, name: `Ada ${family}` });
});

test("nothing, or only whitespace, is no name", () => {
  expect(checkPersonName("")).toEqual({ ok: false, problem: "empty" });
  expect(checkPersonName(" \t\n ")).toEqual({ ok: false, problem: "empty" });
});

test("a name is at most 80 characters, counted as people count them", () => {
  expect(PERSON_NAME_MAX_LENGTH).toBe(80);
  expect(checkPersonName("a".repeat(80))).toEqual({ ok: true, name: "a".repeat(80) });
  expect(checkPersonName("a".repeat(81))).toEqual({ ok: false, problem: "too_long" });
  // The limit is on what is stored, after whitespace is collapsed.
  expect(checkPersonName(`${"a".repeat(40)}      ${"b".repeat(39)}`)).toEqual({
    ok: true,
    name: `${"a".repeat(40)} ${"b".repeat(39)}`,
  });
});

test("an emoji is one character, not two UTF-16 units", () => {
  // 41 emoji are 82 UTF-16 units but 41 characters; 81 of them are one too many.
  expect(checkPersonName("\u{1F600}".repeat(41))).toEqual({
    ok: true,
    name: "\u{1F600}".repeat(41),
  });
  expect(checkPersonName("\u{1F600}".repeat(80)).ok).toBe(true);
  expect(checkPersonName("\u{1F600}".repeat(81))).toEqual({ ok: false, problem: "too_long" });
});

test("a control character is not part of a name", () => {
  for (const value of ["Ada\u0000", "Ada\u0007Lovelace", "\u001bAda", "Ada\u007f", "Ada\u0085"]) {
    expect(checkPersonName(value)).toEqual({ ok: false, problem: "refused" });
  }
});

test("a bidirectional control, which can make a name read as another, is refused wherever it is", () => {
  // Right-to-left override and the isolates and embeddings around it.
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const control = String.fromCodePoint(code);
    expect(checkPersonName(`Ada${control}Lovelace`)).toEqual({ ok: false, problem: "refused" });
    expect(checkPersonName(`${control}Ada`)).toEqual({ ok: false, problem: "refused" });
  }
});

test("a name that shows nothing is refused, whichever invisible character it is made of", () => {
  for (const value of [
    "​", // zero-width space
    "​‌‍",
    "⁠﻿",
    "⠀", // braille pattern blank
    "⠀ ⠀",
    "ㅤ", // Hangul filler
    " ​ ",
  ]) {
    expect(checkPersonName(value)).toEqual({ ok: false, problem: "refused" });
  }
  // An invisible character beside a visible one is left to the person's text.
  expect(checkPersonName("Ada​Lovelace").ok).toBe(true);
});

test("the server's own sender label is not a name, in any case or width", () => {
  expect(SYSTEM_SENDER_LABEL).toBe("System");
  // Invisible characters around or inside it do not make it another name.
  for (const value of [
    "system",
    "System",
    " SYSTEM ",
    "Ｓystem",
    "System\u200b",
    "Sys\u200dtem",
    "\u2060System",
  ]) {
    expect(checkPersonName(value)).toEqual({ ok: false, problem: "refused" });
  }
  // Only the whole name is reserved.
  expect(checkPersonName("System Admin")).toEqual({ ok: true, name: "System Admin" });
});

test("the label the browser shows for a message the server wrote is that reserved label", () => {
  expect(browserSenderName(null)).toBe(SYSTEM_SENDER_LABEL);
});

test("a name that starts with @ is refused: it would read as an Agent's handle", () => {
  for (const value of ["@ada", "  @ada", "＠ada", "\u200b@ada"]) {
    expect(checkPersonName(value)).toEqual({ ok: false, problem: "refused" });
  }
  expect(checkPersonName("ada@example").ok).toBe(true);
});
