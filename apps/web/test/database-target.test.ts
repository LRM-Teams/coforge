import { expect, test } from "bun:test";

import { describeDatabaseTarget } from "#src/server/db/database-target.server";

/** What an operator is told about the database a script is about to use: where, never who. */

test("the host, port and database name are shown, and the credentials are not", () => {
  const described = describeDatabaseTarget(
    "postgresql://coforge:s3cret-pw@127.0.0.1:5433/coforge?sslmode=require&password=also-secret",
  );

  expect(described).toBe("127.0.0.1:5433/coforge");
  expect(described).not.toContain("s3cret");
  expect(described).not.toContain("also-secret");
});

test("the default port is shown when the URL names none", () => {
  expect(describeDatabaseTarget("postgres://u:p@postgres/coforge")).toBe("postgres:5432/coforge");
});

test("an IPv6 host keeps its brackets", () => {
  expect(describeDatabaseTarget("postgresql://u:p@[::1]:5433/coforge")).toBe("[::1]:5433/coforge");
});

test("a URL that cannot be read is not echoed", () => {
  const described = describeDatabaseTarget("not a url with s3cret in it");

  expect(described).toBe("(unparseable URL)");
});

test("a password that breaks the URL apart never shows as a host, port or database name", () => {
  // Each of these reads as a URL whose host, port or path is the start or the rest of the
  // password, unless the result is checked for what a host and a database name look like.
  for (const password of [
    "zq7Xk/wv9",
    "zq7Xk@wv9",
    "zq7Xk#wv9",
    "zq7Xk?wv9",
    "12345/zq7Xk",
    "zq7Xk wv9",
  ]) {
    const described = describeDatabaseTarget(
      `postgresql://coforge:${password}@db.internal:5433/coforge`,
    );

    expect(described).not.toContain("zq7Xk");
    expect(described).not.toContain("wv9");
    expect(described).not.toContain("12345");
    expect(described === "db.internal:5433/coforge" || described === "(unparseable URL)").toBe(
      true,
    );
  }
});

test("a database name that is not one segment is not shown", () => {
  expect(describeDatabaseTarget("postgresql://u:p@db.internal:5433/a/b")).toBe("(unparseable URL)");
  expect(describeDatabaseTarget("postgresql://u:p@db.internal:5433")).toBe("(unparseable URL)");
});
