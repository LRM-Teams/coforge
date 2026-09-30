/**
 * The one rule for a person's name, wherever they set it: the full name asked at first sign-in and
 * the profile's own name. It is pure and client-safe, so the server (which decides) and a page
 * (which words the problem) share it.
 */

/** The longest a person's name may be, in characters as people count them (code points). */
export const PERSON_NAME_MAX_LENGTH = 80;

/**
 * The label the browser shows for a message the server wrote itself (`browserSenderName`). A
 * person cannot take it as their name: their messages would read as the server's.
 */
export const SYSTEM_SENDER_LABEL = "System";

/** Why a name is not accepted; a page words each one. `refused` covers every name the rule bars
 * outright: reserved, an Agent-looking `@`, control, bidirectional or invisible characters. */
export type PersonNameProblem = "empty" | "too_long" | "refused";

export type PersonNameCheck =
  | { ok: true; name: string }
  | { ok: false; problem: PersonNameProblem };

/** Unicode normalization form C, whitespace runs as one space, trimmed. */
export function normalizePersonName(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim();
}

// Control characters, and the bidirectional embeddings, overrides and isolates that can make a
// name read as another (U+202A-U+202E, U+2066-U+2069).
const CONTROL_OR_BIDI = /[\p{Cc}‪-‮⁦-⁩]/u;
// What draws nothing: format characters (zero-width space, joiners, word joiner), separators and
// whitespace, plus the blank-looking letters and marks the categories miss (braille blank,
// combining grapheme joiner, the Hangul fillers).
const INVISIBLE = /[\p{Cf}\p{Z}\s͏ᅟᅠ⠀ㅤﾠ]/gu;

/**
 * A person's name as it is stored, or the problem with it. It is normalized (`normalizePersonName`)
 * and 1 to `PERSON_NAME_MAX_LENGTH` characters. Refused: control and bidirectional characters, a
 * name of nothing but invisible characters (a zero-width joiner inside a visible name is fine),
 * the server's own sender label as the whole name, and a leading `@`, which reads as an Agent.
 */
export function checkPersonName(input: string): PersonNameCheck {
  const name = normalizePersonName(input);
  if (!name) return { ok: false, problem: "empty" };
  if ([...name].length > PERSON_NAME_MAX_LENGTH) return { ok: false, problem: "too_long" };
  // Full-width and other look-alike forms (`Ｓystem`, `＠ada`) fold to what they imitate, and
  // invisible characters (`System\u200b`, `\u200b@ada`) are not there to a reader. Only these
  // two comparisons use the folded form; the name is stored as written.
  const folded = name.normalize("NFKC").replace(INVISIBLE, "");
  if (
    CONTROL_OR_BIDI.test(name) ||
    !name.replace(INVISIBLE, "") ||
    folded.toLowerCase() === SYSTEM_SENDER_LABEL.toLowerCase() ||
    folded.startsWith("@")
  ) {
    return { ok: false, problem: "refused" };
  }
  return { ok: true, name };
}
