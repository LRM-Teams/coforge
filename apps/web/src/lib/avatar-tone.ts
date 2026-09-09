/**
 * Deterministic placeholder styling for the official Avatar component
 * (`@/components/base/avatar/avatar`) when there is no photo. Untitled's
 * Avatar always falls back to a neutral `bg-tertiary` tile; CoForge tints the
 * tile by a hash of the person's name via `contentClassName` so the same
 * person keeps the same colour on every screen without the server having to
 * store one.
 */

const TONE_COUNT = 6;

export function avatarInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

export function avatarToneClassName(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) % 4093;
  }
  const tone = (hash % TONE_COUNT) + 1;
  return `bg-avatar-${tone} text-white`;
}
