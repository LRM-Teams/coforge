import { expect, test } from "bun:test";

import { signedInAccount } from "#src/server/auth/signed-in-account.server";

// The account "Signed in as ..." names, and whether that person still has to be asked for a full
// name. The signed session says who signed in; the names come from the database.

type Row = { fullName: string | null; displayName: string | null; username: string } | null;

function databaseWith(row: Row) {
  return { user: { findUnique: async () => row } } as never;
}

const session = {
  id: "user-1",
  email: null,
  username: "ada",
  name: "Provider Ada",
  authingSub: "authing-ada",
};

test("an account with an email is named by it, whatever its names are", async () => {
  const db = databaseWith({ fullName: "Ada Lovelace", displayName: null, username: "ada" });

  expect(await signedInAccount(db, { ...session, email: "ada@example.com" })).toEqual({
    account: "ada@example.com",
    named: true,
  });
});

test("an account with no email is named by the stored name, never by the provider's or an @username", async () => {
  const db = databaseWith({ fullName: "Ada Lovelace", displayName: null, username: "ada" });

  expect(await signedInAccount(db, session)).toEqual({ account: "Ada Lovelace", named: true });
});

test("a person who has not been asked for a full name is not named yet", async () => {
  const db = databaseWith({ fullName: null, displayName: "Countess", username: "ada" });

  expect(await signedInAccount(db, session)).toEqual({ account: "Countess", named: false });
});

test("a session whose user is gone is signed in as its username and still has to be named", async () => {
  expect(await signedInAccount(databaseWith(null), session)).toEqual({
    account: "ada",
    named: false,
  });
});
