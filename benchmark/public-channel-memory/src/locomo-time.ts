const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * Parse LoCoMo session stamps such as "9:36 am on 2 April, 2023".
 * Falls back to an ordered synthetic instant so quiet windows still close.
 */
export function parseLocomoDateTime(raw: string, fallbackIndex: number): Date {
  const text = raw.trim();
  const match = text.match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i,
  );
  if (!match) {
    return new Date(Date.UTC(2023, 0, 1, 12, 0, 0) + fallbackIndex * 86_400_000);
  }
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]!.toLowerCase();
  const day = Number(match[4]);
  const month = MONTHS[match[5]!.toLowerCase()];
  const year = Number(match[6]);
  if (month === undefined || Number.isNaN(hours) || Number.isNaN(day) || Number.isNaN(year)) {
    return new Date(Date.UTC(2023, 0, 1, 12, 0, 0) + fallbackIndex * 86_400_000);
  }
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return new Date(Date.UTC(year, month, day, hours, minutes, 0));
}

export function turnBody(turn: { text: string; blipCaption?: string; query?: string }): string {
  const text = turn.text.trim();
  const parts: string[] = [];
  if (turn.blipCaption?.trim()) parts.push(`image description: ${turn.blipCaption.trim()}`);
  if (turn.query?.trim()) parts.push(`image search/query text: ${turn.query.trim()}`);
  if (parts.length === 0) return text;
  const note = `(attached image; ${parts.join("; ")})`;
  return text ? `${text}\n${note}` : note;
}
