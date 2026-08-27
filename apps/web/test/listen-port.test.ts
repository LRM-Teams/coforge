import { expect, test } from "bun:test";

import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  FORBIDDEN_LOCAL_PORT,
  readListenPort,
} from "../scripts/listen-port";

test("local frontend and backend ports are distinct and are not 3000", () => {
  expect(DEFAULT_FRONTEND_PORT).toBe(8788);
  expect(DEFAULT_BACKEND_PORT).toBe(8789);
  expect(DEFAULT_FRONTEND_PORT).not.toBe(FORBIDDEN_LOCAL_PORT);
  expect(DEFAULT_BACKEND_PORT).not.toBe(FORBIDDEN_LOCAL_PORT);
  expect(DEFAULT_FRONTEND_PORT).not.toBe(DEFAULT_BACKEND_PORT);
});

test("readListenPort uses the fallback when PORT is unset", () => {
  expect(readListenPort({}, DEFAULT_FRONTEND_PORT)).toBe(8788);
});

test("readListenPort rejects port 3000", () => {
  expect(() => readListenPort({ PORT: "3000" }, DEFAULT_FRONTEND_PORT)).toThrow(
    "local Web scripts must not use port 3000",
  );
});
