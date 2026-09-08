import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";

const GROUP = 4;

/**
 * The eight-character code, one box per character, in two groups matching the `XXXX-XXXX` shape
 * it is displayed with in the terminal.
 *
 * The boxes are presentation only: they exist because a code read off another screen is typed
 * one glance at a time, and separated characters are much easier to keep your place in. The value
 * is still one string, so paste, autofill and screen readers see a single field rather than eight
 * unrelated ones.
 */
export function DeviceCodeInput({
  value,
  onChange,
  onSubmit,
  disabled,
  label,
  invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  label: string;
  invalid?: boolean;
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const characters = value.padEnd(8, " ").slice(0, 8).split("");

  function setCharacter(index: number, raw: string) {
    const character = raw
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(-1);
    if (!character) return;
    const next = characters
      .map((c, i) => (i === index ? character : c))
      .join("")
      .trimEnd();
    onChange(next);
    inputs.current[Math.min(index + 1, 7)]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      // Clear this box if it holds anything, otherwise step back and clear that one - the
      // behaviour people already expect from every other code field.
      const target = characters[index]?.trim() ? index : Math.max(index - 1, 0);
      onChange(
        characters
          .map((c, i) => (i === target ? " " : c))
          .join("")
          .trimEnd(),
      );
      inputs.current[target]?.focus();
      return;
    }
    if (event.key === "ArrowLeft") inputs.current[Math.max(index - 1, 0)]?.focus();
    if (event.key === "ArrowRight") inputs.current[Math.min(index + 1, 7)]?.focus();
  }

  /** A pasted code arrives complete, usually with the dash and often with surrounding
   * whitespace. Spreading it across the boxes is the only sane response. */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const pasted = event.clipboardData
      .getData("text")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 8);
    if (!pasted) return;
    onChange(pasted);
    inputs.current[Math.min(pasted.length, 7)]?.focus();
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center justify-center gap-2 sm:gap-3"
    >
      {characters.map((character, index) => (
        <div key={index} className="contents">
          <input
            ref={(element) => {
              inputs.current[index] = element;
            }}
            value={character.trim()}
            onChange={(event) => setCharacter(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={handlePaste}
            onFocus={(event) => event.target.select()}
            disabled={disabled}
            inputMode="text"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={1}
            aria-label={`${label} ${index + 1}`}
            aria-invalid={invalid || undefined}
            className={`size-11 rounded-lg border bg-background text-center font-mono text-lg font-medium uppercase tabular-nums shadow-sm outline-none transition-colors sm:size-12 ${
              invalid
                ? "border-destructive-text focus:border-destructive-text"
                : "border-border focus:border-brand focus:ring-2 focus:ring-brand/25"
            } disabled:opacity-50`}
          />
          {index === GROUP - 1 ? (
            <span aria-hidden="true" className="select-none text-muted-foreground">
              –
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
