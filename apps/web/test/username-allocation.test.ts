import { expect, test } from "bun:test";

import { USERNAME_PATTERN } from "#src/lib/username-grammar";
import { UsernameAllocator, usernameBase } from "#src/server/auth/username-allocation.server";

const uniqueViolation = () => Object.assign(new Error("unique"), { code: "P2002" });

// --- The base name a sign-in profile yields ---

test("a preferred_username that is already a name is the base", () => {
  expect(usernameBase({ preferredUsername: "ada" })).toBe("ada");
  expect(usernameBase({ preferredUsername: " Ada " })).toBe("ada");
  expect(usernameBase({ preferredUsername: "ada2024-x9" })).toBe("ada2024-x9");
});

test("the sources are tried in order: preferred_username, email, name, nickname, then user", () => {
  const all = {
    preferredUsername: "grace",
    email: "ada@example.com",
    name: "Alan Turing",
    nickname: "Ace",
  };
  expect(usernameBase(all)).toBe("grace");
  expect(usernameBase({ ...all, preferredUsername: null })).toBe("ada");
  expect(usernameBase({ ...all, preferredUsername: null, email: null })).toBe("alan-turing");
  expect(usernameBase({ ...all, preferredUsername: null, email: null, name: "安栋" })).toBe("ace");
  expect(usernameBase({})).toBe("user");
});

test("the email's local part is normalised and loses its +tag", () => {
  expect(usernameBase({ email: "Ada.Lovelace+news@Example.com" })).toBe("ada-lovelace");
  expect(usernameBase({ email: "ada_@example.com" })).toBe("ada");
  expect(usernameBase({ email: "+tag@example.com", name: "Grace Hopper" })).toBe("grace-hopper");
});

test("a preferred_username that is not already a name is skipped rather than rewritten", () => {
  expect(usernameBase({ preferredUsername: "Ada Lovelace", email: "ada@example.com" })).toBe("ada");
  expect(usernameBase({ preferredUsername: "_ada", email: "grace@example.com" })).toBe("grace");
});

test("a name with no ASCII letters yields nothing, and the next source is used", () => {
  expect(usernameBase({ name: "安栋" })).toBe("user");
  expect(usernameBase({ name: "安栋", nickname: "Dong" })).toBe("dong");
  expect(usernameBase({ name: "安栋", email: null, nickname: "  " })).toBe("user");
});

test("a base starts with a letter: a digit start gets the prefix u", () => {
  expect(usernameBase({ preferredUsername: "1049208871" })).toBe("u1049208871");
  expect(usernameBase({ email: "9lives@example.com" })).toBe("u9lives");
});

test("a candidate of 11 or more digits looks like a phone number and is never used", () => {
  expect(usernameBase({ preferredUsername: "13800138000", email: "ada@example.com" })).toBe("ada");
  expect(usernameBase({ email: "13800138000@example.com" })).toBe("user");
  expect(usernameBase({ name: "8613800138000" })).toBe("user");
  // Separators do not hide a phone number.
  expect(usernameBase({ name: "138 0013 8000", email: null })).toBe("user");
  expect(usernameBase({ email: "86.138.0013.8000@example.com" })).toBe("user");
  expect(usernameBase({ name: "+86 (138) 0013-8000" })).toBe("user");
  // Ten digits is still a name (a QQ number, say), and takes the prefix.
  expect(usernameBase({ email: "1546778759@qq.com" })).toBe("u1546778759");
});

test("a phone number is not used even with letters around it", () => {
  const ada = { email: "ada@example.com" };
  expect(usernameBase({ ...ada, preferredUsername: "wx13800138000" })).toBe("ada");
  expect(usernameBase({ ...ada, preferredUsername: "u13800138000" })).toBe("ada");
  expect(usernameBase({ ...ada, preferredUsername: "13800138000x" })).toBe("ada");
  expect(usernameBase({ name: "Tel 138-0013-8000" })).toBe("user");
  expect(usernameBase({ email: "tel_13800138000@example.com" })).toBe("user");
  // Digits split by letters are not one run, and ten in a row is not eleven.
  expect(usernameBase({ preferredUsername: "ada123456-abc-12345" })).toBe("ada123456-abc-12345");
  expect(usernameBase({ preferredUsername: "wx1380013800" })).toBe("wx1380013800");
});

test("a candidate shorter than 3 characters is not a username", () => {
  expect(usernameBase({ preferredUsername: "ab", email: "al@example.com", name: "Ada" })).toBe(
    "ada",
  );
  expect(usernameBase({ email: "x@example.com" })).toBe("user");
  // A single digit becomes the two characters u1, still too short.
  expect(usernameBase({ preferredUsername: "1" })).toBe("user");
});

test("a reserved word is skipped, whichever source it comes from", () => {
  for (const word of [
    "admin",
    "all",
    "channel",
    "channels",
    "everyone",
    "general",
    "group",
    "groups",
    "here",
    "me",
    "you",
    "system",
    "human",
    "agent",
    "coforge",
    "settings",
    "workspaces",
  ]) {
    expect(usernameBase({ preferredUsername: word, email: `${word}@example.com` })).toBe("user");
    expect(usernameBase({ preferredUsername: word, name: "Ada Lovelace" })).toBe("ada-lovelace");
  }
});

test("user itself is not reserved: it is the last-resort base", () => {
  expect(usernameBase({ preferredUsername: "user" })).toBe("user");
});

test("a long base is cut to 24 characters and never ends in a separator", () => {
  const long = usernameBase({ email: `${"a".repeat(40)}@example.com` });
  expect(long).toBe("a".repeat(24));
  expect(usernameBase({ email: `${"a".repeat(23)}-bbbbbbbb@example.com` })).toBe("a".repeat(23));
});

test("every base is a username the grammar allows", () => {
  const profiles = [
    { preferredUsername: "ada" },
    { preferredUsername: "1049208871" },
    { email: "Ada.Lovelace+news@Example.com" },
    { email: `${"z".repeat(50)}@example.com` },
    { name: "Grace Hopper" },
    { name: "安栋" },
    {},
  ];
  for (const profile of profiles) expect(USERNAME_PATTERN.test(usernameBase(profile))).toBe(true);
});

// --- Taking the smallest free name ---

function allocator(taken: string[]) {
  const asked: string[] = [];
  return {
    asked,
    allocator: new UsernameAllocator(async (base) => {
      asked.push(base);
      return taken.filter((name) => name === base || name.startsWith(`${base}-`));
    }),
  };
}

test("a free base is used as it is", async () => {
  const { allocator: usernames, asked } = allocator(["someone-else"]);

  expect(await usernames.create({ email: "ada@example.com" }, async (name) => name)).toBe("ada");
  expect(asked).toEqual(["ada"]);
});

test("a taken base takes the smallest free -N, N from 2", async () => {
  const create = (taken: string[]) =>
    allocator(taken).allocator.create({ email: "ada@example.com" }, async (name) => name);

  expect(await create(["ada"])).toBe("ada-2");
  expect(await create(["ada", "ada-2"])).toBe("ada-3");
  expect(await create(["ada", "ada-3"])).toBe("ada-2");
  expect(await create(["ada", "ada-2", "ada-3", "ada-4"])).toBe("ada-5");
});

test("only the base and its -N are collisions: a longer name or a hex-suffixed one is not", async () => {
  const taken = ["ada3x", "ada3-d9956ab1", "ada33", "ada3-", "ada3-2x"];
  const { allocator: usernames } = allocator(taken);

  expect(await usernames.create({ email: "ada3@example.com" }, async (name) => name)).toBe("ada3");
  expect(
    await allocator([...taken, "ada3"]).allocator.create(
      { email: "ada3@example.com" },
      async (name) => name,
    ),
  ).toBe("ada3-2");
});

test("a name taken between the read and the create is tried again with the next free one", async () => {
  const taken = new Set<string>();
  const usernames = new UsernameAllocator(async (base) =>
    [...taken].filter((name) => name === base || name.startsWith(`${base}-`)),
  );
  const attempts: string[] = [];

  const created = await usernames.create({ email: "ada@example.com" }, async (name) => {
    attempts.push(name);
    // A concurrent sign-in takes whichever name this one asked for first, twice over.
    if (attempts.length <= 2) {
      taken.add(name);
      throw uniqueViolation();
    }
    return name;
  });

  expect(attempts).toEqual(["ada", "ada-2", "ada-3"]);
  expect(created).toBe("ada-3");
});

test("after 5 losses the name gets an 8-hex suffix, still within the grammar", async () => {
  const attempts: string[] = [];
  const usernames = new UsernameAllocator(async () => []);

  const created = await usernames.create(
    { email: `${"a".repeat(30)}@example.com` },
    async (name) => {
      attempts.push(name);
      if (attempts.length <= 5) throw uniqueViolation();
      return name;
    },
  );

  expect(attempts).toHaveLength(6);
  expect(attempts.slice(0, 5)).toEqual(Array(5).fill("a".repeat(24)));
  expect(created).toMatch(/^a{23}-[0-9a-f]{8}$/);
  expect(USERNAME_PATTERN.test(created)).toBe(true);
});

test("a failure of the hex-suffixed create is the caller's, and an error other than a collision is never retried", async () => {
  const usernames = new UsernameAllocator(async () => []);
  let calls = 0;

  await expect(
    usernames.create({ email: "ada@example.com" }, async () => {
      calls += 1;
      throw uniqueViolation();
    }),
  ).rejects.toMatchObject({ code: "P2002" });
  expect(calls).toBe(6);

  calls = 0;
  await expect(
    usernames.create({ email: "ada@example.com" }, async () => {
      calls += 1;
      throw new Error("connection lost");
    }),
  ).rejects.toThrow("connection lost");
  expect(calls).toBe(1);
});
