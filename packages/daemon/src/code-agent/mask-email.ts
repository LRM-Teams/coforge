/** Masks a signed-in account's email before it ever leaves this Computer, ported from Raft's
 * `maskRuntimeAccountEmail` (bundle L813142): the local part keeps its first 3 characters (1
 * when shorter than 8) plus up to 5 trailing characters only when more than 4 remain, the
 * domain is lowercased, and anything that is not one plain, well-formed address is dropped, so
 * no full address or malformed input ever reaches the wire. Shared by every provider's usage
 * reader that reports the signed-in account. */
export function maskEmail(value: string): string | undefined {
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email))
    return undefined;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (
    local.length > 64 ||
    domain.length > 63 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  )
    return undefined;
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-") ||
        !/^[a-z0-9-]+$/.test(label),
    )
  )
    return undefined;
  const prefixLength = local.length >= 8 ? 3 : 1;
  const remaining = local.length - prefixLength;
  const suffixLength = remaining > 4 ? Math.min(5, remaining - 4) : 0;
  const masked = `${local.slice(0, prefixLength)}****${suffixLength > 0 ? local.slice(-suffixLength) : ""}@${domain}`;
  return masked.length <= 80 ? masked : undefined;
}
