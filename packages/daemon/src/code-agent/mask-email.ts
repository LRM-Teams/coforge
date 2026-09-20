/** `frank.an@example.com` → `fr****@example.com`; anything that is not one plain address is
 * dropped, so the full address never leaves this Computer. Shared by every provider's usage
 * reader that reports the signed-in account. */
export function maskEmail(email: string): string | undefined {
  const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(email.trim());
  if (!match || email.length > 70) return undefined;
  return `${match[1]!.slice(0, 2)}****@${match[2]!.toLowerCase()}`;
}
