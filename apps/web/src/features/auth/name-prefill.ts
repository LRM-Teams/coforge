import { checkPersonName } from "#src/features/profiles/person-name";

/**
 * What the name field starts with: the name the sign-in provider reported, when it reads as one.
 * Providers fill that field with whatever the account was made with, and a phone number or an
 * email address is not a name, so those (and anything the field would refuse) leave it empty.
 */
export function namePrefill(providerName: string): string {
  const checked = checkPersonName(providerName);
  if (!checked.ok) return "";
  return looksLikePhoneNumber(checked.name) || looksLikeEmail(checked.name) ? "" : checked.name;
}

/** Six to fifteen digits (E.164's longest is fifteen), with a leading `+` and the separators
 * people write numbers with. */
function looksLikePhoneNumber(value: string): boolean {
  return /^\+?\d{6,15}$/.test(value.replace(/[\s().-]/g, ""));
}

function looksLikeEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value);
}
