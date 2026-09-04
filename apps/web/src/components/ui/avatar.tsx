import { cn } from "@/lib/utils";

/**
 * The single avatar component for the whole app.
 *
 * One shape everywhere: a rounded square, never a circle. One person renders
 * as one tile, several people render as tiles inside a single avatar-sized
 * square, and `layout="stack"` renders them as an overlapping row instead.
 *
 * The placeholder fill is derived from the name, so the same person keeps the
 * same colour on every screen without the server having to store one.
 */

export type AvatarTone = 1 | 2 | 3 | 4 | 5 | 6;

export type AvatarPerson = {
  name: string;
  src?: string | null;
  tone?: AvatarTone;
};

const toneClassName: Record<AvatarTone, string> = {
  1: "bg-avatar-1",
  2: "bg-avatar-2",
  3: "bg-avatar-3",
  4: "bg-avatar-4",
  5: "bg-avatar-5",
  6: "bg-avatar-6",
};

const sizeClassName = {
  xs: "size-5 rounded-[5px] text-[9px]",
  sm: "size-8 rounded-lg text-xs",
  md: "size-9 rounded-[10px] text-xs",
  lg: "size-11 rounded-xl text-sm",
  xl: "size-12 rounded-xl text-sm",
} as const;

export type AvatarSize = keyof typeof sizeClassName;

export function Avatar({
  people,
  size = "md",
  layout = "tiles",
  online,
  initials,
  className,
}: {
  people: AvatarPerson[];
  size?: AvatarSize;
  /** `tiles` keeps a group inside one square; `stack` overlaps them in a row. */
  layout?: "tiles" | "stack";
  /** Presence dot. Omit it entirely when presence is unknown or irrelevant. */
  online?: boolean;
  /** Overrides the derived initials. Only meaningful for a single person. */
  initials?: string;
  className?: string;
}) {
  if (people.length === 0) {
    return null;
  }

  const face =
    layout === "stack" ? (
      <span className="flex items-center">
        {people.map((person, index) => (
          <Face
            key={person.name}
            person={person}
            size={size}
            className={cn("ring-2 ring-card", index > 0 && "-ml-1.5", className)}
          />
        ))}
      </span>
    ) : people.length === 1 ? (
      <Face person={people[0]!} size={size} initials={initials} className={className} />
    ) : (
      <span
        aria-hidden="true"
        className={cn(
          "grid shrink-0 gap-px overflow-hidden bg-border",
          people.length <= 4 ? "grid-cols-2" : "grid-cols-3",
          sizeClassName[size],
          className,
        )}
      >
        {people.slice(0, 6).map((person) => (
          <span
            key={person.name}
            className={cn(
              "flex items-center justify-center text-[8px] font-semibold text-white",
              toneClassName[toneOf(person)],
            )}
          >
            {initialOf(person.name)}
          </span>
        ))}
      </span>
    );

  if (online === undefined) {
    return face;
  }

  return (
    <span className="relative flex shrink-0">
      {face}
      <span
        aria-hidden="true"
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card",
          online ? "bg-success" : "bg-offline",
        )}
      />
    </span>
  );
}

function Face({
  person,
  size,
  initials,
  className,
}: {
  person: AvatarPerson;
  size: AvatarSize;
  initials?: string;
  className?: string;
}) {
  if (person.src) {
    return (
      <img
        src={person.src}
        alt=""
        className={cn("shrink-0 object-cover", sizeClassName[size], className)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold text-white",
        sizeClassName[size],
        toneClassName[toneOf(person)],
        className,
      )}
    >
      {initials ?? initialOf(person.name)}
    </span>
  );
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function toneOf(person: AvatarPerson): AvatarTone {
  if (person.tone) {
    return person.tone;
  }

  let hash = 0;
  for (const character of person.name) {
    hash = (hash * 31 + character.codePointAt(0)!) % 4093;
  }
  return ((hash % 6) + 1) as AvatarTone;
}
