import { expect, test } from "bun:test";

import { accountLabel } from "#src/features/auth/account-label";

// "Signed in as ..." names the account by the email its sign-in reported. An account without one
// (a phone-number sign-up) is named by its @username, never by a phone number.

test("an account with an email is named by it", () => {
  expect(accountLabel({ email: "ada@example.com", username: "ada" })).toBe("ada@example.com");
});

test("an account with no email is named by its @username", () => {
  expect(accountLabel({ email: null, username: "user-0a1b2c3d" })).toBe("@user-0a1b2c3d");
});
