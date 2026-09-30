/** A hostname, or a bracketed IPv6 address: nothing a password could break into. */
const HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])$/;
/** One path segment: a database name, and not the rest of a credential that split the URL. */
const DATABASE_PATH = /^\/[A-Za-z0-9_.-]+$/;

const UNPARSEABLE = "(unparseable URL)";

/**
 * Where a connection string points, for a person to check before a script writes to it:
 * `hostname:port/database`. The user, the password and every query parameter are left out, so the
 * result is safe to print. A password with a `/`, `#`, `?` or `@` in it can make a URL parse with a
 * host, port or path that is really part of the credential, so each part printed has to look like
 * what it claims to be; a string that fails any of that is not echoed, only called unparseable.
 */
export function describeDatabaseTarget(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return UNPARSEABLE;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return UNPARSEABLE;
  if (url.hostname && !HOST.test(url.hostname)) return UNPARSEABLE;
  if (!DATABASE_PATH.test(url.pathname)) return UNPARSEABLE;
  return `${url.hostname || "(local socket)"}:${url.port || "5432"}${url.pathname}`;
}
